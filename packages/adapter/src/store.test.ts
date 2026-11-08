import { expect, it, vi } from "vitest";
import type { ConversationId, ConversationRecord, ConversationView, SubmissionRecord } from "@earendil-works/pi-durable";
import type { PiClient } from "./client.js";
import { PiRuntimeStore } from "./store.js";

const id = (value: number) => value as ConversationId;
const record = (value: number): ConversationRecord => ({ id: id(value) });
const view = (value: ConversationId): ConversationView => ({ conversation: { id: value }, entries: [], docs: {} });

function client(overrides: Partial<PiClient> = {}): PiClient {
  return {
    listConversations: async () => ({ items: [] }),
    createConversation: async () => record(2),
    getConversationView: async (value) => view(value),
    entries: async () => ({ items: [] }),
    submit: async () => ({ id: 3, conversationId: 2, type: "input", status: "queued" } as SubmissionRecord),
    getSubmission: async () => ({ id: 3, conversationId: 2, type: "input", status: "queued" } as SubmissionRecord),
    watch: (value, onView) => { onView(view(value)); return () => {}; },
    ...overrides,
  };
}

it("loads all native conversation pages with one metadata-directory request", async () => {
  const list = vi.fn<PiClient["listConversations"]>(async (_query, _limit, cursor) => cursor
    ? { items: [record(8)] }
    : { items: [record(2)], next: { after: 2 } });
  const listMetadata = vi.fn(async () => ({ "2": { title: "Named conversation", archived: false, feedback: {}, suggestions: [] } }));
  const store = new PiRuntimeStore(client({ listConversations: list, listMetadata }));
  await store.refreshConversations();
  expect(store.getSnapshot().conversations.map((item) => item.id)).toEqual([2, 8]);
  expect(store.getSnapshot().metadata["2"]?.title).toBe("Named conversation");
  expect(list).toHaveBeenCalledTimes(2);
  expect(listMetadata).toHaveBeenCalledOnce();
});

it("publishes loading while a new conversation is being admitted", async () => {
  let resolve!: (value: ConversationRecord) => void;
  const pending = new Promise<ConversationRecord>((done) => { resolve = done; });
  const store = new PiRuntimeStore(client({ createConversation: () => pending }));
  store.start();
  const creation = store.createConversation();
  expect(store.getSnapshot().isLoading).toBe(true);
  resolve(record(8));
  await creation;
  expect(store.getSnapshot().selectedId).toBe(8);
  expect(store.getSnapshot().isLoading).toBe(false);
  store.stop();
});

it("restores the composer loading state and exposes a failed creation", async () => {
  const failure = new Error("Host unavailable");
  const store = new PiRuntimeStore(client({ createConversation: async () => { throw failure; } }));
  await expect(store.createConversation()).rejects.toThrow("Host unavailable");
  expect(store.getSnapshot().isLoading).toBe(false);
  expect(store.getSnapshot().error).toBe(failure);
});
