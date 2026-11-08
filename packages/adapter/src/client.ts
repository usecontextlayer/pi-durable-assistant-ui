import { applyImmutable, type Op } from "@earendil-works/chord/delta";
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

export type HttpPiWatchFrame =
  | { type: "view"; view: ConversationView }
  | { type: "ops"; ops: readonly Op[] };

export type PiConnectionState = "idle" | "connecting" | "connected" | "reconnecting";

export interface PiWatchOptions {
  window?: () => ConversationWindow | undefined;
  onConnection?: (state: PiConnectionState) => void;
  onError?: (error: Error) => void;
}

export interface PiUploadResult {
  name: string;
  content: Exclude<UserInput, string>;
}

/** The native operations a browser needs, with server execution context already bound. */
export interface PiClient {
  listConversations(query?: ConversationQuery, limit?: number, cursor?: Cursor): Promise<Page<ConversationRecord, Cursor>>;
  createConversation(options?: SerializedConversationCreateOptions): Promise<ConversationRecord>;
  getConversationView(id: ConversationId): Promise<ConversationView>;
  entries(id: ConversationId, query: Omit<EntryQuery, "conversationId">, limit: number, cursor?: Cursor, signal?: AbortSignal): Promise<Page<EntryRecord, Cursor>>;
  submit(id: ConversationId, submission: SubmissionDraft): Promise<SubmissionRecord>;
  getSubmission(id: SubmissionId): Promise<SubmissionRecord>;
  watch(id: ConversationId, onView: (view: ConversationView) => void, options?: PiWatchOptions): () => void;
  configure?(id: ConversationId, change: SerializedAgentChange): Promise<void>;
  abort?(id: ConversationId, options?: ConversationAbortOptions): Promise<void>;
  abortSubmission?(id: SubmissionId): ReturnType<Harness["abortSubmission"]>;
  reset?(id: ConversationId, handoff?: string): Promise<void>;
  compact?(id: ConversationId, instructions?: string): Promise<TaskId<CompactionResult>>;
  fork?(id: ConversationId, at: EntryId, options?: SerializedConversationCreateOptions): Promise<ConversationRecord>;
  context?(id: ConversationId, at?: EntryId): Promise<ContextView>;
  uploadFile?(file: File, signal?: AbortSignal): Promise<PiUploadResult>;
  respondToHumanInput?(taskId: TaskId, response: string): Promise<void>;
  inspect?(): Promise<HarnessInspection>;
  listMetadata?(): Promise<Record<string, ConversationMetadata>>;
  getMetadata?(id: ConversationId): Promise<ConversationMetadata>;
  updateMetadata?(id: ConversationId, patch: ConversationMetadataPatch): Promise<ConversationMetadata>;
  setFeedback?(id: ConversationId, entryId: EntryId, rating: "positive" | "negative" | null): Promise<ConversationMetadata>;
}

export interface HttpPiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  eventSource?: (url: string) => EventSource;
  reconnectDelayMs?: number;
}

export function createHttpPiClient(options: HttpPiClientOptions = {}): Required<PiClient> {
  const baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const openEvents = options.eventSource ?? ((url: string) => new EventSource(url));

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
    respondToHumanInput: async (taskId, response) => { await post(`/interactions/${taskId}`, { response }); },
    inspect: () => request("/inspect"),
    listMetadata: () => request("/conversations/metadata"),
    getMetadata: (id) => request(`/conversations/${id}/metadata`),
    updateMetadata: (id, patch) => request(`/conversations/${id}/metadata`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
    setFeedback: (id, entryId, rating) => post(`/conversations/${id}/feedback`, { entryId, rating }),
    watch(id, onView, watchOptions = {}) {
      let source: EventSource | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let connectedBefore = false;

      function connect() {
        if (stopped) return;
        watchOptions.onConnection?.(connectedBefore ? "reconnecting" : "connecting");
        const connection = openEvents(url(`/conversations/${id}/watch`, { window: watchOptions.window?.() }));
        source = connection;
        let view: ConversationView | undefined;
        connection.onmessage = (event: MessageEvent<string>) => {
          try {
            const frame = JSON.parse(event.data) as HttpPiWatchFrame;
            if (frame.type === "view") view = frame.view;
            else {
              if (!view) throw new Error("Pi watch sent changes before its initial view");
              view = applyImmutable(view, frame.ops);
            }
            connectedBefore = true;
            watchOptions.onConnection?.("connected");
            onView(view);
          } catch (cause) {
            watchOptions.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
            connection.close();
          }
        };
        connection.onerror = () => {
          connection.close();
          if (stopped) return;
          watchOptions.onConnection?.("reconnecting");
          retry = setTimeout(connect, options.reconnectDelayMs ?? 500);
        };
      }

      connect();
      return () => {
        stopped = true;
        clearTimeout(retry);
        source?.close();
      };
    },
  };
}
