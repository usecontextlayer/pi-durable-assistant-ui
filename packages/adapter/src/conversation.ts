import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { WatchEnd, WatchHandle } from "@earendil-works/chord";
import { ConversationTranscript, type ConversationId, type ConversationView, type EntryId, type SubmissionDraft, type TranscriptView } from "@earendil-works/pi-durable";
import type { AppendMessage } from "@assistant-ui/react";
import type { PiDurableClient, PiDurableConnectionState, SerializedAgentChange } from "./client.js";
import { EMPTY_CONVERSATION_METADATA, type ConversationMetadata } from "./metadata.js";
import { conversationLiveState, entryIdFromMessageId, projectConversation, toPiUserInput } from "./projection.js";

export interface PiDurableConversationState {
  readonly view: TranscriptView | undefined;
  readonly metadata: ConversationMetadata;
  readonly connection: PiDurableConnectionState;
  readonly isLoading: boolean;
  readonly error: Error | undefined;
}

/** Disposable observation and actions permanently bound to one native conversation. */
export class PiDurableConversation {
  readonly transcript: ConversationTranscript;
  readonly #listeners = new Set<() => void>();
  #controller: AbortController | undefined;
  #state: PiDurableConversationState = { view: undefined, metadata: EMPTY_CONVERSATION_METADATA, connection: "idle", isLoading: true, error: undefined };

  constructor(readonly client: PiDurableClient, readonly id: ConversationId, pageSize?: number) {
    this.transcript = new ConversationTranscript((query, limit, context) => client.entries(id, query, limit, undefined, context.abortSignal), { pageSize });
  }

  getSnapshot = (): PiDurableConversationState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<PiDurableConversationState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  reportError = (error: unknown) => {
    this.#set({ error: error instanceof Error ? error : new Error(String(error)), isLoading: false });
  };

  start = (): void => {
    if (!this.#controller) void this.#connect();
  };

  #connect(): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;
    this.#set({ isLoading: !this.#state.view, error: undefined });
    const observe = async <T>(acquire: () => Promise<WatchHandle<T>>, accept: (value: T) => Promise<void> | void) => {
      const watch = await acquire();
      await accept(watch.value);
      watch.start(async (change) => {
        if (change.kind === "value") await accept(change.value);
        else this.reportError(change.error);
      });
      void watch.closed.then((end) => {
        if (!controller.signal.aborted) this.#ended(end);
      });
    };
    const observations = [observe(() => this.client.watch(this.id, {
      signal: controller.signal,
      window: () => this.transcript.resume,
      onConnection: (connection) => { if (!controller.signal.aborted) this.#set({ connection }); },
    }), async (view: ConversationView) => {
      if (controller.signal.aborted) return;
      this.#set({ view: this.transcript.merge(view), isLoading: false, error: undefined });
      const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      let gap = this.#state.view?.items.find((item) => item.kind === "gap");
      while (gap?.kind === "gap" && !controller.signal.aborted) {
        this.#set({ view: await this.transcript.fillGap(gap, context) });
        gap = this.#state.view?.items.find((item) => item.kind === "gap");
      }
    })];
    if (this.client.watchMetadata) {
      observations.push(observe(() => this.client.watchMetadata!(this.id, controller.signal), (metadata) => {
        if (!controller.signal.aborted) this.#set({ metadata });
      }));
    }
    const ready = Promise.all(observations).then(() => {});
    void ready.catch((error) => { if (!controller.signal.aborted) this.reportError(error); });
    return ready;
  }

  #ended(end: WatchEnd) {
    this.#set({ connection: "closed", isLoading: false });
    if ("error" in end) this.reportError(end.error);
  }

  stop = (): void => {
    this.#controller?.abort();
    this.#controller = undefined;
  };

  reload = (): Promise<void> => { this.stop(); return this.#connect(); };
  submit = (draft: SubmissionDraft) => this.client.submit(this.id, draft);
  continue = () => this.submit({ type: "continue" });
  steer = (content: Extract<SubmissionDraft, { type: "input" }>["content"]) => this.submit({ type: "input", content, whenBusy: "steer" });
  followUp = (content: Extract<SubmissionDraft, { type: "input" }>["content"]) => this.submit({ type: "input", content, whenBusy: "followUp" });

  cancel = () => {
    if (!this.client.abort) throw new Error("This Pi host does not expose cancellation");
    return this.client.abort(this.id);
  };
  abortSubmission = (id: Parameters<NonNullable<PiDurableClient["abortSubmission"]>>[0]) => {
    if (!this.client.abortSubmission) throw new Error("This Pi host does not expose submission withdrawal");
    return this.client.abortSubmission(id);
  };
  configure = (change: SerializedAgentChange) => {
    if (!this.client.configure) throw new Error("This Pi host does not expose configuration");
    return this.client.configure(this.id, change);
  };
  reset = (handoff?: string) => {
    if (!this.client.reset) throw new Error("This Pi host does not expose reset");
    return this.client.reset(this.id, handoff);
  };
  compact = (instructions?: string) => {
    if (!this.client.compact) throw new Error("This Pi host does not expose compaction");
    return this.client.compact(this.id, instructions);
  };
  forkAt = (at: EntryId) => {
    if (!this.client.fork) throw new Error("This Pi host does not expose forks");
    return this.client.fork(this.id, at);
  };

  edit = async (message: AppendMessage) => {
    if (!message.sourceId) throw new Error("An edit must identify its original message");
    const target = entryIdFromMessageId(message.sourceId);
    const fork = await this.forkAt(target);
    await this.client.submit(fork.id, { type: "write", entry: { kind: "assistant-ui.context-edit", edits: [{ target, action: "replace", messages: [{ role: "user", content: toPiUserInput(message), timestamp: Date.now() }] }] } });
    await this.client.submit(fork.id, { type: "continue" });
    return fork;
  };

  regenerate = async (parentId: string | null, sourceId?: string) => {
    const view = this.#state.view;
    const messages = view ? projectConversation(view, this.#state.metadata) : [];
    const index = parentId === null ? -1 : messages.findIndex((message) => message.id === parentId);
    const answer = sourceId === undefined ? messages[index + 1] : messages.find((message) => message.id === sourceId);
    if (!answer?.id || answer.role !== "assistant") throw new Error("No committed assistant response follows this message");
    const failure = view && conversationLiveState(view).runFailure;
    if (view && failure && answer.id === `failure:${failure.taskId}`) {
      await this.continue();
      return view.conversation;
    }
    const entryId = answer.metadata?.custom?.entryId;
    if (typeof entryId !== "number") throw new Error("No committed assistant response follows this message");
    const target = entryId as EntryId;
    const fork = await this.forkAt(target);
    await this.client.submit(fork.id, { type: "write", entry: { kind: "assistant-ui.context-edit", edits: [{ target, action: "omit" }] } });
    await this.client.submit(fork.id, { type: "continue" });
    return fork;
  };

  loadEarlier = async () => {
    const context = this.#controller ? withAbortSignal(this.#controller.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
    this.#set({ view: await this.transcript.loadEarlier(context) });
  };

  setFeedback = async (messageId: string, rating: "positive" | "negative") => {
    if (!this.client.setFeedback) throw new Error("This Pi host does not expose feedback");
    this.#set({ metadata: await this.client.setFeedback(this.id, entryIdFromMessageId(messageId), rating) });
  };
}
