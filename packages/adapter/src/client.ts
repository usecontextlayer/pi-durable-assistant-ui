import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { Watch, type WatchHandle, type WatchEnd, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationCreateOptions,
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  ConversationView,
  ConversationWindow,
  ConversationAbortOptions,
  ContextView,
  AgentState,
  CompactionResult,
  Cursor,
  EntryQuery,
  EntryRecord,
  EntryId,
  Page,
  SubmissionDraft,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  UserInput,
  Harness,
  HarnessInspection,
} from "@earendil-works/pi-durable";
import type { ConversationMetadata, ConversationMetadataPatch } from "./metadata.js";

/** JSON form of Pi's stored configuration; the host resolves registry names. */
export type SerializedAgentChange = { [K in keyof AgentState]?: AgentState[K] | null };
export type SerializedConversationCreateOptions = Omit<ConversationCreateOptions, "agent" | "init"> & { agent?: SerializedAgentChange };

export type HttpPiDurableWatchFrame<T = ConversationView> =
  | { type: "view"; view: T }
  | { type: "ops"; ops: readonly Op[] }
  | { type: "failed"; error: string }
  | { type: "end"; kind: WatchEnd["kind"]; error?: string };

export type HttpPiDurableWatchSubscription = {
  subscriptionId: number;
  id: ConversationId;
  kind: "conversation" | "metadata";
  window?: ConversationWindow;
};

export type HttpPiDurableWatchEnvelope = { subscriptionId: number; frame: HttpPiDurableWatchFrame<unknown> };

export type PiDurableConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface PiDurableWatchOptions {
  window?: () => ConversationWindow | undefined;
  onConnection?: (state: PiDurableConnectionState) => void;
  signal?: AbortSignal;
}

export type PiDurableHumanInputDetails = {
  type: "human-input";
  taskId: TaskId;
  prompt: string;
} & ({ status: "pending" } | { status: "answered"; response: string });

export interface PiDurableUploadResult {
  name: string;
  content: Exclude<UserInput, string>;
}

/** The native operations a browser needs, with server execution context already bound. */
export interface PiDurableClient {
  listConversations(query?: ConversationQuery, limit?: number, cursor?: Cursor): Promise<Page<ConversationRecord, Cursor>>;
  createConversation(options?: SerializedConversationCreateOptions): Promise<ConversationRecord>;
  getConversationView(id: ConversationId): Promise<ConversationView>;
  entries(id: ConversationId, query: Omit<EntryQuery, "conversationId">, limit: number, cursor?: Cursor, signal?: AbortSignal): Promise<Page<EntryRecord, Cursor>>;
  submit(id: ConversationId, submission: SubmissionDraft): Promise<SubmissionRecord>;
  getSubmission(id: SubmissionId): Promise<SubmissionRecord>;
  watch(id: ConversationId, options?: PiDurableWatchOptions): Promise<WatchHandle<ConversationView>>;
  watchMetadata?(id: ConversationId, signal?: AbortSignal): Promise<WatchHandle<ConversationMetadata>>;
  configure?(id: ConversationId, change: SerializedAgentChange): Promise<void>;
  abort?(id: ConversationId, options?: ConversationAbortOptions): Promise<void>;
  abortSubmission?(id: SubmissionId): ReturnType<Harness["abortSubmission"]>;
  reset?(id: ConversationId, handoff?: string): Promise<void>;
  compact?(id: ConversationId, instructions?: string): Promise<TaskId<CompactionResult>>;
  fork?(id: ConversationId, at: EntryId, options?: SerializedConversationCreateOptions): Promise<ConversationRecord>;
  context?(id: ConversationId, at?: EntryId): Promise<ContextView>;
  uploadFile?(file: File, signal?: AbortSignal): Promise<PiDurableUploadResult>;
  respondToHumanInput?(taskId: TaskId, response: string): Promise<void>;
  inspect?(): Promise<HarnessInspection>;
  listMetadata?(ids: readonly ConversationId[]): Promise<Record<string, ConversationMetadata>>;
  getMetadata?(id: ConversationId): Promise<ConversationMetadata>;
  updateMetadata?(id: ConversationId, patch: ConversationMetadataPatch): Promise<ConversationMetadata>;
  setFeedback?(id: ConversationId, entryId: EntryId, rating: "positive" | "negative" | null): Promise<ConversationMetadata>;
}

export interface HttpPiDurableClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  eventSource?: (url: string) => EventSource;
  reconnectDelayMs?: number;
}

export function createHttpPiDurableClient(options: HttpPiDurableClientOptions = {}): Required<PiDurableClient> {
  const baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const openEvents = options.eventSource ?? ((url: string) => new EventSource(url));

  const subscriptions = new Map<number, {
    request: () => HttpPiDurableWatchSubscription;
    receive: (frame: HttpPiDurableWatchFrame<unknown>) => void;
    connection: (state: PiDurableConnectionState) => void;
  }>();
  let nextSubscriptionId = 0;
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let connectQueued = false;

  function scheduleConnect() {
    clearTimeout(retry);
    if (connectQueued) return;
    connectQueued = true;
    queueMicrotask(() => { connectQueued = false; connect(); });
  }

  function connect() {
    source?.close();
    source = undefined;
    if (subscriptions.size === 0) return;
    for (const subscription of subscriptions.values()) subscription.connection("connecting");
    const connection = openEvents(url("/watch", { subscriptions: [...subscriptions.values()].map((subscription) => subscription.request()) }));
    source = connection;
    connection.onopen = () => {
      for (const subscription of subscriptions.values()) subscription.connection("connected");
    };
    connection.onmessage = (event: MessageEvent<string>) => {
      try {
        const { subscriptionId, frame } = JSON.parse(event.data) as HttpPiDurableWatchEnvelope;
        subscriptions.get(subscriptionId)?.receive(frame);
      } catch (error) {
        connection.close();
        for (const subscription of subscriptions.values()) subscription.receive({ type: "end", kind: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    };
    connection.onerror = () => {
      if (connection.readyState === connection.CLOSED) {
        for (const subscription of subscriptions.values()) subscription.receive({ type: "end", kind: "failed", error: "Pi watch connection closed." });
        return;
      }
      connection.close();
      for (const subscription of subscriptions.values()) subscription.connection("reconnecting");
      if (subscriptions.size > 0) retry = setTimeout(connect, options.reconnectDelayMs ?? 500);
    };
  }

  function url(path: string, query: Record<string, unknown> = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const search = params.toString();
    return `${baseUrl}${path}${search ? `?${search}` : ""}`;
  }

  async function request<T>(path: string, init?: RequestInit, query?: Record<string, unknown>): Promise<T> {
    const response = await fetcher(url(path, query), init);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || `Pi request failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  function post<T>(path: string, value: unknown): Promise<T> {
    return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  }

  return {
    listConversations: (query = {}, limit = 100, cursor) => request("/conversations", undefined, { query, limit, cursor }),
    createConversation: (creation = { ownership: { kind: "ownerless" } }) => post("/conversations", creation),
    getConversationView: (id) => request(`/conversations/${id}`),
    entries: (id, query, limit, cursor, signal) => request(`/conversations/${id}/entries`, { signal }, { ...query, limit, cursor }),
    submit: (id, submission) => post(`/conversations/${id}/submit`, submission),
    getSubmission: (id) => request(`/submissions/${id}`),
    configure: async (id, change) => { await post(`/conversations/${id}/configure`, change); },
    abort: async (id, abortOptions = {}) => { await post(`/conversations/${id}/abort`, abortOptions); },
    abortSubmission: (id) => post(`/submissions/${id}/abort`, {}),
    reset: async (id, handoff) => { await post(`/conversations/${id}/reset`, { handoff }); },
    compact: async (id, instructions) => (await post<{ taskId: TaskId<CompactionResult> }>(`/conversations/${id}/compact`, { instructions })).taskId,
    fork: (id, at, forkOptions = { ownership: { kind: "ownerless" } }) => post(`/conversations/${id}/fork`, { at, ...forkOptions }),
    context: (id, at) => request(`/conversations/${id}/context`, undefined, { at }),
    uploadFile: (file, signal) => request("/files", { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file, signal }, { name: file.name }),
    respondToHumanInput: async (taskId, response) => { await post(`/human-input/${taskId}`, { response }); },
    inspect: () => request("/inspect"),
    listMetadata: (ids) => post("/conversations/metadata", { ids }),
    getMetadata: (id) => request(`/conversations/${id}/metadata`),
    updateMetadata: (id, patch) => request(`/conversations/${id}/metadata`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
    setFeedback: (id, entryId, rating) => post(`/conversations/${id}/feedback`, { entryId, rating }),
    watch: (id, watchOptions = {}) => openWatch<ConversationView>(id, "conversation", watchOptions),
    watchMetadata: (id, signal) => openWatch<ConversationMetadata>(id, "metadata", { signal }),
  };

  function openWatch<T>(id: ConversationId, kind: HttpPiDurableWatchSubscription["kind"], watchOptions: PiDurableWatchOptions): Promise<WatchHandle<T>> {
    return new Promise((resolve, reject) => {
      const subscriptionId = ++nextSubscriptionId;
      let observation: Watch<T> | undefined;
      let value: T;

      function dispose() {
        subscriptions.delete(subscriptionId);
        watchOptions.signal?.removeEventListener("abort", abort);
        scheduleConnect();
      }

      function abort() {
        dispose();
        if (observation) observation.abort();
        else reject(watchOptions.signal?.reason ?? new DOMException("Observation aborted", "AbortError"));
      }

      subscriptions.set(subscriptionId, {
        request: () => ({ subscriptionId, id, kind, window: watchOptions.window?.() }),
        connection: (state) => watchOptions.onConnection?.(state === "connecting" && observation ? "reconnecting" : state),
        receive(raw) {
          try {
            const frame = raw as HttpPiDurableWatchFrame<T>;
            if (frame.type === "end") {
              dispose();
              watchOptions.onConnection?.("closed");
              const error = new Error(frame.error ?? `Pi observation ended: ${frame.kind}`);
              if (!observation) reject(error);
              else observation.end(frame.kind === "failed" || frame.kind === "listener_error" ? { kind: frame.kind, error } : { kind: frame.kind });
              return;
            }
            if (frame.type === "failed") {
              if (!observation) throw new Error(frame.error);
              observation.fail(new Error(frame.error), BACKGROUND_CONTEXT);
              return;
            }
            if (frame.type === "view") value = frame.view;
            else {
              if (!observation) throw new Error("Pi watch sent changes before its initial view");
              value = applyImmutable(value, frame.ops);
            }
            if (!observation) {
              observation = new Watch(value, dispose, console.error);
              resolve(observation);
            } else {
              observation.advance({ kind: "value", value, ops: frame.type === "ops" ? frame.ops : [["r", value as JsonValue]], retired: false }, BACKGROUND_CONTEXT);
            }
          } catch (error) {
            dispose();
            watchOptions.onConnection?.("closed");
            if (observation) observation.end({ kind: "failed", error });
            else reject(error);
          }
        },
      });
      if (watchOptions.signal?.aborted) abort();
      else {
        watchOptions.signal?.addEventListener("abort", abort, { once: true });
        scheduleConnect();
      }
    });
  }
}
