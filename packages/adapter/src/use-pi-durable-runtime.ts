import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAui, useAuiState, useExternalStoreRuntime, useRemoteThreadListRuntime, type AppendMessage, type AssistantRuntime, type AttachmentAdapter, type DictationAdapter, type ExternalThreadQueueAdapter, type FeedbackAdapter, type QueueItemState, type SpeechSynthesisAdapter, type ThreadMessageLike } from "@assistant-ui/react";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { PiDurableClient } from "./client.js";
import { PiDurableConversation, type PiDurableConversationState } from "./conversation.js";
import { EMPTY_CONVERSATION_METADATA } from "./metadata.js";
import { conversationInbox, conversationLiveState, isForegroundRunning, projectConversationHistory, projectConversationLive, toPiUserInput } from "./projection.js";
import { createPiDurableThreadListAdapter, nativeConversationId } from "./thread-list.js";

export interface UsePiDurableRuntimeOptions {
  client: PiDurableClient;
  threadId?: ConversationId;
  onThreadIdChange?: (id: ConversationId | undefined) => void;
  pageSize?: number;
  attachments?: AttachmentAdapter;
  speech?: SpeechSynthesisAdapter;
  dictation?: DictationAdapter;
  feedback?: FeedbackAdapter;
}

export interface PiDurableRuntimeExtras {
  readonly conversation: PiDurableConversation | undefined;
  readonly state: PiDurableConversationState;
}

const DRAFT_STATE: PiDurableConversationState = { view: undefined, metadata: EMPTY_CONVERSATION_METADATA, connection: "idle", isLoading: false, error: undefined };
const EMPTY_SUBSCRIPTION = () => () => {};
const DRAFT_SNAPSHOT = () => DRAFT_STATE;
const DRAFT_EXTRAS: PiDurableRuntimeExtras = { conversation: undefined, state: DRAFT_STATE };
const identity = (message: ThreadMessageLike) => message;
const EMPTY_HISTORY = projectConversationHistory([]);

/** Read Pi-specific state/actions from the current Assistant UI thread scope. */
export function usePiDurable(): PiDurableRuntimeExtras {
  return useAuiState((state) => state.thread.extras as PiDurableRuntimeExtras | undefined ?? DRAFT_EXTRAS);
}

export function usePiDurableRuntime(options: UsePiDurableRuntimeOptions): AssistantRuntime {
  const { client, pageSize, threadId, onThreadIdChange } = options;
  const adapter = useMemo(() => createPiDurableThreadListAdapter(client, pageSize), [client, pageSize]);
  return useRemoteThreadListRuntime({
    adapter,
    threadId: threadId === undefined ? undefined : String(threadId),
    onThreadIdChange: (id) => onThreadIdChange?.(id === undefined ? undefined : nativeConversationId(id)),
    runtimeHook: () => usePiDurableThreadRuntime(options),
  });
}

function usePiDurableThreadRuntime({ client, pageSize, attachments, speech, dictation, feedback }: UsePiDurableRuntimeOptions): AssistantRuntime {
  const aui = useAui();
  const remoteId = useAuiState((state) => state.threadListItem.remoteId);
  const isSelected = useAuiState((state) => state.threads.mainThreadId === state.threadListItem.id);
  const hasAttachments = useAuiState((state) => state.threads.mainThreadId === state.threadListItem.id && state.threads.main.composer.attachments.length > 0);
  const conversation = useMemo(() => remoteId === undefined ? undefined : new PiDurableConversation(client, nativeConversationId(remoteId), pageSize), [client, remoteId, pageSize]);
  const state = useSyncExternalStore(conversation?.subscribe ?? EMPTY_SUBSCRIPTION, conversation?.getSnapshot ?? DRAFT_SNAPSHOT, conversation?.getSnapshot ?? DRAFT_SNAPSHOT);
  const [sendError, setSendError] = useState<Error>();
  useEffect(() => {
    if (!isSelected) return;
    conversation?.start();
    return () => conversation?.stop();
  }, [conversation, isSelected]);

  const history = useMemo(() => state.view ? projectConversationHistory(state.view.items, state.metadata) : EMPTY_HISTORY, [state.view?.items, state.metadata.feedback]);
  const live = state.view ? conversationLiveState(state.view) : undefined;
  const messages = useMemo(() => state.view && live ? projectConversationLive(history, live, state.view.conversation.id) : [], [history, live, state.view?.conversation.id]);
  const isRunning = state.view ? isForegroundRunning(state.view) : false;

  const send = async (message: AppendMessage, whenBusy?: "followUp" | "steer") => {
    setSendError(undefined);
    const { remoteId: id } = await aui.threadListItem().initialize();
    await client.submit(nativeConversationId(id), { type: "input", content: toPiUserInput(message), whenBusy });
  };
  const reportSendError = (error: unknown) => setSendError(error instanceof Error ? error : new Error(String(error)));
  const queue = useMemo<ExternalThreadQueueAdapter | undefined>(() => {
    if (!client.abortSubmission) return undefined;
    const items = state.view ? conversationInbox(state.view).items : [];
    const convert = (mode: "steer" | "followUp"): QueueItemState[] => items.flatMap((item) => {
      if (item.mode !== mode || !("content" in item)) return [];
      const content = typeof item.content === "string" ? [{ type: "text" as const, text: item.content }] : item.content;
      const parts: QueueItemState["parts"] = content.map((part) => part.type === "text" ? part : { type: "file", mimeType: part.mimeType, data: part.data });
      return [{ id: String(item.id), prompt: content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), parts }];
    });
    return {
      items: convert("followUp"), steerItems: convert("steer"),
      enqueue: (message) => { void send(message, "followUp").catch(reportSendError); },
      steer: (message) => { void send(message, "steer").catch(reportSendError); },
      remove: (id) => { void client.abortSubmission!(Number(id) as Parameters<NonNullable<PiDurableClient["abortSubmission"]>>[0]).catch(reportSendError); },
      move: () => { throw new Error("Pi Durable does not support moving queued submissions."); },
      edit: () => { throw new Error("Pi Durable does not support editing queued submissions."); },
    };
  }, [client, remoteId, state.view?.docs["pi.inbox"]]);
  const nativeFeedback = useMemo<FeedbackAdapter | undefined>(() => conversation && client.setFeedback ? { submit: ({ message, type }) => conversation.setFeedback(message.id, type) } : undefined, [conversation, client]);
  const extras = useMemo<PiDurableRuntimeExtras>(() => ({ conversation, state: sendError ? { ...state, error: sendError } : state }), [conversation, state, sendError]);

  return useExternalStoreRuntime({
    messages,
    convertMessage: identity,
    isRunning,
    isSendDisabled: isRunning && hasAttachments,
    isLoading: state.isLoading,
    hasEarlier: state.view?.items[0]?.kind === "earlier",
    onLoadEarlier: conversation?.loadEarlier,
    onRefetchThread: conversation?.reload,
    onNew: send,
    onCancel: conversation && client.abort ? conversation.cancel : undefined,
    onEdit: conversation && client.fork ? async (message) => { const fork = await conversation.edit(message); await aui.threads().switchToThread(String(fork.id)); } : undefined,
    onReload: conversation && client.fork ? async (parentId, config) => {
      const destination = await conversation.regenerate(parentId, config.sourceId ?? undefined);
      if (destination.id !== conversation.id) await aui.threads().switchToThread(String(destination.id));
    } : undefined,
    onRespondToToolApproval: client.respondToHumanInput ? async ({ approvalId, text }) => {
      if (text === undefined) throw new Error("This human-input request requires a text response");
      await client.respondToHumanInput!(Number(approvalId) as TaskId, text);
    } : undefined,
    suggestions: state.metadata.suggestions.map((prompt) => ({ prompt })),
    queue,
    extras,
    adapters: { attachments, speech, dictation, feedback: feedback ?? nativeFeedback },
  });
}
