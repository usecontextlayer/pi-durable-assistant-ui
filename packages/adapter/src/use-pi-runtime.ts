import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useExternalStoreRuntime, type AttachmentAdapter, type DictationAdapter, type FeedbackAdapter, type SpeechSynthesisAdapter } from "@assistant-ui/react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PiClient } from "./client.js";
import { PiRuntimeStore, type PiRuntimeStoreOptions } from "./store.js";
import { toPiUserInput } from "./projection.js";
import { EMPTY_CONVERSATION_METADATA } from "./metadata.js";

export interface UsePiRuntimeOptions extends PiRuntimeStoreOptions {
  client: PiClient;
  whenBusy?: "followUp" | "steer" | "reject";
  attachments?: AttachmentAdapter;
  speech?: SpeechSynthesisAdapter;
  dictation?: DictationAdapter;
  feedback?: FeedbackAdapter;
}

export function usePiRuntime({ client, initialConversationId, pageSize, whenBusy, attachments, speech, dictation, feedback }: UsePiRuntimeOptions) {
  const store = useMemo(() => new PiRuntimeStore(client, { initialConversationId, pageSize }), [client, pageSize]);
  useEffect(() => { store.start(); return store.stop; }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const metadata = state.metadata[String(state.selectedId)] ?? EMPTY_CONVERSATION_METADATA;
  const nativeFeedback = useMemo<FeedbackAdapter | undefined>(() => client.setFeedback ? {
    submit: ({ message, type }) => store.submitFeedback(message.id, type),
  } : undefined, [client, store]);
  const threads = state.conversations.map((conversation) => {
    const details = state.metadata[String(conversation.id)] ?? EMPTY_CONVERSATION_METADATA;
    const item = { id: String(conversation.id), title: details.title ?? `Conversation ${conversation.id}` };
    return details.archived ? { ...item, status: "archived" as const } : { ...item, status: "regular" as const };
  });
  const runtime = useExternalStoreRuntime({
    messages: state.messages,
    convertMessage: (message) => message,
    isRunning: state.isRunning,
    isLoading: state.isLoading,
    hasEarlier: state.hasEarlier,
    onLoadEarlier: store.loadEarlier,
    onNew: async (message) => { await store.submit({ type: "input", content: toPiUserInput(message), whenBusy }); },
    onCancel: client.abort ? store.cancel : undefined,
    onEdit: client.fork ? store.edit : undefined,
    onReload: client.fork ? store.regenerate : undefined,
    suggestions: metadata.suggestions.map((prompt) => ({ prompt })),
    adapters: {
      attachments,
      speech,
      dictation,
      feedback: feedback ?? nativeFeedback,
      threadList: {
        threadId: state.selectedId === undefined ? undefined : String(state.selectedId),
        threads: threads.filter((thread) => thread.status === "regular"),
        archivedThreads: threads.filter((thread) => thread.status === "archived"),
        onSwitchToThread: (id) => store.selectConversation(Number(id) as ConversationId),
        onSwitchToNewThread: async () => { await store.createConversation(); },
        onRename: client.updateMetadata ? (id, title) => store.renameConversation(Number(id) as ConversationId, title) : undefined,
        onArchive: client.updateMetadata ? (id) => store.archiveConversation(Number(id) as ConversationId) : undefined,
        onUnarchive: client.updateMetadata ? (id) => store.unarchiveConversation(Number(id) as ConversationId) : undefined,
      },
    },
  });
  return { runtime, state, actions: store };
}
