import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ConversationTranscript } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  SubmissionDraft,
  SubmissionRecord,
  TranscriptView,
} from "@earendil-works/pi-durable";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { PiClient, PiConnectionState, SerializedConversationCreateOptions, SerializedAgentChange } from "./client.js";
import { conversationLiveState, entryIdFromMessageId, isForegroundRunning, projectConversation, toPiUserInput } from "./projection.js";
import type { ConversationMetadata, ConversationMetadataPatch } from "./metadata.js";

export interface PiRuntimeState {
  readonly conversations: readonly ConversationRecord[];
  readonly selectedId: ConversationId | undefined;
  readonly view: TranscriptView | undefined;
  readonly messages: readonly ThreadMessageLike[];
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly connection: PiConnectionState;
  readonly error: Error | undefined;
  readonly hasEarlier: boolean;
  readonly metadata: Readonly<Record<string, ConversationMetadata>>;
}

type PiRuntimeSource = Omit<PiRuntimeState, "messages" | "isRunning" | "hasEarlier">;

function runtimeSnapshot(source: PiRuntimeSource): PiRuntimeState {
  const { view } = source;
  return {
    ...source,
    messages: view ? projectConversation(view, source.metadata[String(view.conversation.id)]) : [],
    isRunning: view ? isForegroundRunning(view) : false,
    hasEarlier: view?.items[0]?.kind === "earlier",
  };
}

export interface PiRuntimeStoreOptions {
  initialConversationId?: ConversationId;
  pageSize?: number;
}

/** A disposable client view of Pi, not a second durable conversation store. */
export class PiRuntimeStore {
  readonly client: PiClient;
  readonly #options: PiRuntimeStoreOptions;
  readonly #listeners = new Set<() => void>();
  readonly #transcripts = new Map<ConversationId, ConversationTranscript>();
  readonly #views = new Map<ConversationId, TranscriptView>();
  readonly #filling = new Map<ConversationId, Promise<void>>();
  #disconnect: (() => void) | undefined;
  #selection = new AbortController();
  #started = false;
  #state: PiRuntimeState;

  constructor(client: PiClient, options: PiRuntimeStoreOptions = {}) {
    this.client = client;
    this.#options = options;
    this.#state = runtimeSnapshot({ conversations: [], selectedId: options.initialConversationId, view: undefined, isLoading: false, connection: "idle", error: undefined, metadata: {} });
  }

  getSnapshot = (): PiRuntimeState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<PiRuntimeSource>) {
    const next = { ...this.#state, ...patch };
    this.#state = next.view === this.#state.view && next.metadata === this.#state.metadata ? next : runtimeSnapshot(next);
    for (const listener of this.#listeners) listener();
  }

  #report(cause: unknown) {
    this.#set({ error: cause instanceof Error ? cause : new Error(String(cause)), isLoading: false });
  }

  #transcript(id: ConversationId): ConversationTranscript {
    let transcript = this.#transcripts.get(id);
    if (!transcript) {
      transcript = new ConversationTranscript((query, limit, context) => this.client.entries(id, query, limit, undefined, context.abortSignal), { pageSize: this.#options.pageSize });
      this.#transcripts.set(id, transcript);
    }
    return transcript;
  }

  #show(id: ConversationId, view: TranscriptView) {
    this.#views.set(id, view);
    if (this.#state.selectedId !== id) return;
    this.#set({ view, isLoading: false, error: undefined });
  }

  start = (): void => {
    if (this.#started) return;
    this.#started = true;
    if (this.#state.selectedId !== undefined) this.selectConversation(this.#state.selectedId);
    void this.refreshConversations().catch((error) => this.#report(error));
  };

  stop = (): void => {
    this.#started = false;
    this.#disconnect?.();
    this.#disconnect = undefined;
    this.#selection.abort();
  };

  refreshConversations = async (): Promise<void> => {
    const load = async () => {
      const conversations: ConversationRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await this.client.listConversations({}, 100, cursor);
        conversations.push(...page.items);
        cursor = page.next;
      } while (cursor);
      return conversations;
    };
    const [conversations, loaded] = await Promise.all([load(), this.client.listMetadata?.()]);
    this.#set({ conversations, ...(loaded ? { metadata: loaded } : {}) });
    if (this.#started && this.#state.selectedId === undefined && conversations[0]) this.selectConversation(conversations[0].id);
  };

  selectConversation = (id: ConversationId): void => {
    this.#disconnect?.();
    this.#selection.abort();
    this.#selection = new AbortController();
    const cached = this.#views.get(id);
    this.#set({ selectedId: id, view: cached, isLoading: !cached, error: undefined, connection: "connecting" });
    if (!this.#started) return;
    const transcript = this.#transcript(id);
    this.#disconnect = this.client.watch(id, (view) => {
      const previous = this.#views.get(id);
      this.#show(id, transcript.merge(view));
      if (previous && conversationLiveState(previous).run && !conversationLiveState(view).run) void this.refreshConversations().catch((cause) => this.#report(cause));
      const signal = this.#selection.signal;
      void this.#fillGaps(id).catch((cause) => { if (!signal.aborted && this.#state.selectedId === id) this.#report(cause); });
    }, {
      window: () => transcript.resume,
      onConnection: (connection) => {
        if (this.#state.selectedId !== id) return;
        const becameConnected = connection === "connected" && this.#state.connection !== "connected";
        this.#set({ connection });
        if (becameConnected) void this.refreshMetadata(id).catch((cause) => this.#report(cause));
      },
      onError: (error) => { if (this.#state.selectedId === id) this.#report(error); },
    });
  };

  createConversation = async (options?: SerializedConversationCreateOptions): Promise<ConversationRecord> => {
    this.#set({ isLoading: true, error: undefined });
    try {
      const conversation = await this.client.createConversation(options);
      this.#set({ conversations: [conversation, ...this.#state.conversations.filter((item) => item.id !== conversation.id)] });
      this.selectConversation(conversation.id);
      return conversation;
    } catch (cause) {
      this.#report(cause);
      throw cause;
    }
  };

  #setMetadata(id: ConversationId, metadata: ConversationMetadata) {
    this.#set({ metadata: { ...this.#state.metadata, [String(id)]: metadata } });
  }

  refreshMetadata = async (id = this.#state.selectedId): Promise<void> => {
    if (id === undefined || !this.client.getMetadata) return;
    this.#setMetadata(id, await this.client.getMetadata(id));
  };

  updateMetadata = async (id: ConversationId, patch: ConversationMetadataPatch): Promise<void> => {
    if (!this.client.updateMetadata) throw new Error("This Pi host does not expose conversation metadata");
    this.#setMetadata(id, await this.client.updateMetadata(id, patch));
  };

  renameConversation = (id: ConversationId, title: string): Promise<void> => this.updateMetadata(id, { title });
  archiveConversation = (id: ConversationId): Promise<void> => this.updateMetadata(id, { archived: true });
  unarchiveConversation = (id: ConversationId): Promise<void> => this.updateMetadata(id, { archived: false });

  setFeedback = async (entryId: EntryId, rating: "positive" | "negative" | null): Promise<void> => {
    const id = this.#state.selectedId;
    if (id === undefined) throw new Error("Select a conversation before leaving feedback");
    if (!this.client.setFeedback) throw new Error("This Pi host does not expose feedback");
    this.#setMetadata(id, await this.client.setFeedback(id, entryId, rating));
  };

  submitFeedback = (messageId: string, rating: "positive" | "negative"): void => {
    void this.setFeedback(entryIdFromMessageId(messageId), rating).catch((cause) => this.#report(cause));
  };

  submit = async (submission: SubmissionDraft): Promise<SubmissionRecord> => {
    const id = this.#state.selectedId ?? (await this.createConversation()).id;
    return this.client.submit(id, submission);
  };

  continue = (): Promise<SubmissionRecord> => this.submit({ type: "continue" });

  steer = (content: Extract<SubmissionDraft, { type: "input" }>["content"]): Promise<SubmissionRecord> => this.submit({ type: "input", content, whenBusy: "steer" });

  abortSubmission = async (id: SubmissionRecord["id"]) => {
    if (!this.client.abortSubmission) throw new Error("This Pi host does not expose submission withdrawal");
    return this.client.abortSubmission(id);
  };

  /** Retrying an edit creates a native fork and records an immutable context replacement there. */
  edit = async (message: AppendMessage): Promise<void> => {
    if (!message.sourceId) throw new Error("An edit must identify its original message");
    const target = entryIdFromMessageId(message.sourceId);
    const content = toPiUserInput(message);
    await this.forkAt(target);
    await this.submit({ type: "write", entry: { kind: "assistant-ui.context-edit", edits: [{ target, action: "replace", messages: [{ role: "user", content, timestamp: Date.now() }] }] } });
    await this.continue();
  };

  /** Keep the answer in original history; the fork omits it from its next model context. */
  regenerate = async (parentId: string | null): Promise<void> => {
    const index = parentId === null ? -1 : this.#state.messages.findIndex((message) => message.id === parentId);
    if (parentId !== null && index === -1) throw new Error(`Parent message ${parentId} is not loaded`);
    const answer = this.#state.messages[index + 1];
    if (!answer?.id || answer.role !== "assistant") throw new Error("No committed assistant response follows this message");
    const target = entryIdFromMessageId(answer.id);
    await this.forkAt(target);
    await this.submit({ type: "write", entry: { kind: "assistant-ui.context-edit", edits: [{ target, action: "omit" }] } });
    await this.continue();
  };

  cancel = async (): Promise<void> => {
    const id = this.#state.selectedId;
    if (id === undefined) return;
    if (!this.client.abort) throw new Error("This Pi host does not expose conversation cancellation");
    await this.client.abort(id);
  };

  configure = async (change: SerializedAgentChange): Promise<void> => {
    const id = this.#state.selectedId;
    if (id === undefined) throw new Error("Select a conversation before configuring it");
    if (!this.client.configure) throw new Error("This Pi host does not expose configuration");
    await this.client.configure(id, change);
  };

  reset = async (handoff?: string): Promise<void> => {
    const id = this.#state.selectedId;
    if (id === undefined) return;
    if (!this.client.reset) throw new Error("This Pi host does not expose reset");
    await this.client.reset(id, handoff);
  };

  compact = async (instructions?: string) => {
    const id = this.#state.selectedId;
    if (id === undefined) throw new Error("Select a conversation before compacting it");
    if (!this.client.compact) throw new Error("This Pi host does not expose compaction");
    return this.client.compact(id, instructions);
  };

  forkAt = async (at: EntryId): Promise<ConversationRecord> => {
    const id = this.#state.selectedId;
    if (id === undefined) throw new Error("Select a conversation before forking it");
    if (!this.client.fork) throw new Error("This Pi host does not expose forks");
    const conversation = await this.client.fork(id, at);
    this.#set({ conversations: [conversation, ...this.#state.conversations] });
    this.selectConversation(conversation.id);
    return conversation;
  };

  loadEarlier = async (): Promise<void> => {
    const id = this.#state.selectedId;
    if (id === undefined) return;
    const view = await this.#transcript(id).loadEarlier(withAbortSignal(this.#selection.signal, BACKGROUND_CONTEXT));
    this.#show(id, view);
  };

  #fillGaps(id: ConversationId): Promise<void> {
    const previous = this.#filling.get(id);
    if (previous) return previous;
    const signal = this.#selection.signal;
    const run = async () => {
      while (!signal.aborted) {
        const gap = this.#views.get(id)?.items.find((item) => item.kind === "gap");
        if (!gap || gap.kind !== "gap") return;
        const view = await this.#transcript(id).fillGap(gap, withAbortSignal(signal, BACKGROUND_CONTEXT));
        this.#show(id, view);
      }
    };
    const pending = run().finally(() => this.#filling.delete(id));
    this.#filling.set(id, pending);
    return pending;
  }
}
