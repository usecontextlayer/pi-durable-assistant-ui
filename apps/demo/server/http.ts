import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationId,
  ConversationQuery,
  ConversationWindow,
  Cursor,
  EntryId,
  EntryQuery,
  SubmissionDraft,
  SubmissionId,
  TaskId,
} from "@earendil-works/pi-durable";
import type { ConversationMetadataPatch, HttpPiWatchFrame, SerializedConversationCreateOptions } from "@usecontextlayer/pi-durable-assistant-ui";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LocalPiHost } from "./host.js";
import { readUploadedFile, storeUploadedFile } from "./env.js";
import { DEMO_SCENARIOS } from "../scenarios/faux-provider.js";
import { respondToHumanInput } from "./interaction.js";
import { createLocalPiClient } from "./local-client.js";
import { NotFoundError } from "./errors.js";

type Fallback = (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) text += chunk;
  if (text.length === 0) return {};
  try {
    return record(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, "Invalid JSON.");
    throw error;
  }
}

function id<T extends number>(value: string | number | undefined, name: string): T {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, `Invalid ${name}.`);
  return parsed as T;
}

function jsonParameter<T>(url: URL, name: string): T | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new HttpError(400, `Invalid JSON in ${name}.`);
  }
}

function page(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new HttpError(400, "Invalid page limit.");
  return { limit, cursor: jsonParameter<Cursor>(url, "cursor") };
}

function order(url: URL): "ascending" | "descending" | undefined {
  const value = url.searchParams.get("order");
  if (value === null) return undefined;
  if (value !== "ascending" && value !== "descending") throw new HttpError(400, "Invalid scan order.");
  return value;
}

async function sendWatch(conversation: Conversation, url: URL, response: ServerResponse) {
  let disconnected = false;
  const closed = new Promise<void>((resolve) => {
    response.once("close", () => {
      disconnected = true;
      resolve();
    });
  });
  const watch = await conversation.watch(BACKGROUND_CONTEXT, jsonParameter<ConversationWindow>(url, "window"));
  try {
    if (disconnected) return;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const send = async (frame: HttpPiWatchFrame) => {
      if (disconnected) return;
      if (response.write(`data: ${JSON.stringify(frame)}\n\n`)) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          response.off("drain", done);
          response.off("close", done);
          resolve();
        };
        response.once("drain", done);
        response.once("close", done);
      });
    };
    await send({ type: "view", view: watch.value });
    watch.start(async (change) => {
      if (change.kind === "value") await send({ type: "ops", ops: change.ops });
    });
    await closed;
  } finally {
    await watch.stop();
  }
}

async function handleApi(piHost: LocalPiHost, client: ReturnType<typeof createLocalPiClient>, request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";

  const interaction = /^\/api\/interactions\/(\d+)$/.exec(url.pathname);
  if (interaction && method === "POST") {
    const input = await body(request);
    if (typeof input.response !== "string") throw new HttpError(400, "Human response must be text.");
    json(response, await respondToHumanInput(piHost.harness, id<TaskId>(interaction[1], "task ID"), input.response, BACKGROUND_CONTEXT));
    return;
  }

  if (url.pathname === "/api/scenarios" && method === "GET") {
    json(response, DEMO_SCENARIOS);
    return;
  }
  if (url.pathname === "/api/files" && method === "POST") {
    const parts: Buffer[] = [];
    for await (const chunk of request) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    json(response, await storeUploadedFile(piHost.paths, {
      name: url.searchParams.get("name") ?? "attachment",
      contentType: request.headers["content-type"]?.split(";")[0] ?? "application/octet-stream",
      data: Buffer.concat(parts),
    }), 201);
    return;
  }
  if (url.pathname.startsWith("/api/files/") && method === "GET") {
    const file = await readUploadedFile(piHost.paths, decodeURIComponent(url.pathname.slice("/api/files/".length)));
    if (!file) throw new HttpError(404, "File not found.");
    response.writeHead(200, { "Content-Type": file.contentType });
    response.end(file.data);
    return;
  }

  if (url.pathname === "/api/models" && method === "GET") {
    json(response, { models: piHost.models.getModels(), defaultAgent: piHost.defaultAgent });
    return;
  }
  if (url.pathname === "/api/inspect" && method === "GET") {
    json(response, await client.inspect());
    return;
  }
  if (url.pathname === "/api/usage" && method === "GET") {
    json(response, await piHost.harness.usage(BACKGROUND_CONTEXT));
    return;
  }
  if (url.pathname === "/api/conversations/metadata" && method === "GET") {
    json(response, await client.listMetadata());
    return;
  }
  if (url.pathname === "/api/conversations") {
    if (method === "GET") {
      const query = jsonParameter<ConversationQuery>(url, "query") ?? {};
      const scanOrder = order(url);
      const { limit, cursor } = page(url);
      json(response, await client.listConversations({ ...query, ...(scanOrder ? { order: scanOrder } : {}) }, limit, cursor));
      return;
    }
    if (method === "POST") {
      const input = await body(request);
      const created = await client.createConversation({
        ownership: { kind: "ownerless" },
        ...input,
        ...(input.agent === undefined ? {} : { agent: record(input.agent) }),
      } as SerializedConversationCreateOptions);
      json(response, created, 201);
      return;
    }
  }

  const submissionRoute = /^\/api\/submissions\/(\d+)(?:\/(abort))?$/.exec(url.pathname);
  if (submissionRoute) {
    const submissionId = id<SubmissionId>(submissionRoute[1], "submission ID");
    if (method === "POST" && submissionRoute[2] === "abort") {
      json(response, await client.abortSubmission(submissionId));
      return;
    }
    if (method === "GET" && !submissionRoute[2]) {
      json(response, await client.getSubmission(submissionId));
      return;
    }
  }

  const route = /^\/api\/conversations\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!route) throw new HttpError(404, "API route not found.");
  const selectedId = id<ConversationId>(route[1], "conversation ID");
  const action = route[2];
  if (method === "GET" && action === "metadata") {
    json(response, await client.getMetadata(selectedId));
    return;
  }
  if (method === "PATCH" && action === "metadata") {
    const update = await body(request);
    if (update.title !== undefined && update.title !== null && typeof update.title !== "string") throw new HttpError(400, "Title must be text or null.");
    if (update.archived !== undefined && typeof update.archived !== "boolean") throw new HttpError(400, "Archived must be a boolean.");
    if (update.suggestions !== undefined && (!Array.isArray(update.suggestions) || update.suggestions.some((value) => typeof value !== "string"))) throw new HttpError(400, "Suggestions must be text values.");
    json(response, await client.updateMetadata(selectedId, update as ConversationMetadataPatch));
    return;
  }
  if (method === "POST" && action === "feedback") {
    const input = await body(request);
    if (input.rating !== null && input.rating !== "positive" && input.rating !== "negative") throw new HttpError(400, "Feedback must be positive, negative, or null.");
    json(response, await client.setFeedback(selectedId, id<EntryId>(input.entryId as number, "entry ID"), input.rating));
    return;
  }
  if (method === "GET" && action === "watch") {
    const selected = await piHost.harness.conversation(selectedId, BACKGROUND_CONTEXT);
    if (!selected) throw new NotFoundError("Conversation not found.");
    await sendWatch(selected, url, response);
    return;
  }
  if (method === "GET" && !action) {
    json(response, await client.getConversationView(selectedId));
    return;
  }
  if (method === "GET" && action === "entries") {
    const query = jsonParameter<Omit<EntryQuery, "conversationId">>(url, "query") ?? {};
    const min = url.searchParams.get("minEntryId");
    const max = url.searchParams.get("maxEntryId");
    const scanOrder = order(url);
    const { limit, cursor } = page(url);
    json(response, await client.entries(selectedId, {
      ...query,
      ...(min === null ? {} : { minEntryId: id<EntryId>(min, "minimum entry ID") }),
      ...(max === null ? {} : { maxEntryId: id<EntryId>(max, "maximum entry ID") }),
      ...(scanOrder ? { order: scanOrder } : {}),
    }, limit, cursor));
    return;
  }
  if (method === "GET" && action === "context") {
    const at = url.searchParams.get("at");
    json(response, await client.context(selectedId, at === null ? undefined : id<EntryId>(at, "entry ID")));
    return;
  }
  if (method === "POST" && action === "submit") {
    const draft = await body(request);
    if (!["input", "write", "continue"].includes(String(draft.type))) throw new HttpError(400, "Invalid submission type.");
    if (draft.type === "input" && typeof draft.content !== "string" && !Array.isArray(draft.content)) {
      throw new HttpError(400, "Input content must be text or Pi content blocks.");
    }
    json(response, await client.submit(selectedId, draft as SubmissionDraft), 201);
    return;
  }
  if (method === "POST" && action === "configure") {
    await client.configure(selectedId, await body(request));
    json(response, { id: selectedId });
    return;
  }
  if (method === "POST" && action === "reset") {
    const input = await body(request);
    if (input.handoff !== undefined && typeof input.handoff !== "string") throw new HttpError(400, "Handoff must be text.");
    await client.reset(selectedId, input.handoff as string | undefined);
    json(response, { id: selectedId });
    return;
  }
  if (method === "POST" && action === "compact") {
    const input = await body(request);
    if (input.instructions !== undefined && typeof input.instructions !== "string") throw new HttpError(400, "Compaction instructions must be text.");
    json(response, { taskId: await client.compact(selectedId, input.instructions as string | undefined) });
    return;
  }
  if (method === "POST" && action === "fork") {
    const input = await body(request);
    const at = id<EntryId>(input.at as number, "fork entry ID");
    const { at: _at, ...options } = input;
    const fork = await client.fork(selectedId, at, {
      ownership: { kind: "ownerless" },
      ...options,
      ...(options.agent === undefined ? {} : { agent: record(options.agent) }),
    } as SerializedConversationCreateOptions);
    json(response, fork, 201);
    return;
  }
  if (method === "POST" && action === "abort") {
    const input = await body(request);
    await client.abort(selectedId, { background: input.background === true });
    json(response, { id: selectedId });
    return;
  }
  throw new HttpError(404, "API route not found.");
}

export function createApiServer(piHost: LocalPiHost, options: { fallback?: Fallback } = {}) {
  const client = createLocalPiClient(piHost);
  return createServer((request, response) => {
    if (!request.url?.startsWith("/api/")) {
      if (options.fallback) {
        options.fallback(request, response, (error) => {
          if (error) {
            response.writeHead(500);
            response.end(error instanceof Error ? error.message : String(error));
          } else {
            response.writeHead(404);
            response.end("Not found");
          }
        });
      } else {
        response.writeHead(404);
        response.end("Not found");
      }
      return;
    }
    void handleApi(piHost, client, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        json(response, { error: error instanceof Error ? error.message : String(error) }, error instanceof HttpError ? error.status : error instanceof NotFoundError ? 404 : error instanceof RangeError ? 400 : 500);
      }
    });
  });
}
