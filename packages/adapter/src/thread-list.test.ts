import { expect, it, vi } from "vitest";
import type { ConversationId, ConversationRecord, ConversationView, SubmissionRecord } from "@earendil-works/pi-durable";
import type { PiDurableClient } from "./client.js";
import { createPiDurableThreadListAdapter } from "./thread-list.js";
import { PiDurableConversation } from "./conversation.js";
import type { AppendMessage } from "@assistant-ui/react";

const id = (value: number) => value as ConversationId;
const record = (value: number): ConversationRecord => ({ id: id(value) });
function client(overrides: Partial<PiDurableClient> = {}): PiDurableClient {
  return {
    listConversations: async () => ({ items: [] }),
    createConversation: async () => record(2),
    getConversationView: async (value) => ({ conversation: { id: value }, entries: [], docs: {} } as ConversationView),
    entries: async () => ({ items: [] }),
    submit: async (value) => ({ id: 3, conversationId: value, type: "input", status: "queued" } as SubmissionRecord),
    getSubmission: async () => ({ id: 3, conversationId: 2, type: "input", status: "queued" } as SubmissionRecord),
    watch: async () => { throw new Error("This operation test does not acquire a watch"); },
    ...overrides,
  };
}

it("pages native conversations and reads metadata only for the requested page", async () => {
  const list = vi.fn<PiDurableClient["listConversations"]>(async (_query, _limit, cursor) => cursor ? { items: [record(8)] } : { items: [record(2)], next: { after: 2 } });
  const listMetadata = vi.fn(async (ids: readonly ConversationId[]) => Object.fromEntries(ids.map((value) => [String(value), { title: `Title ${value}`, feedback: {}, suggestions: [] }])));
  const create = vi.fn(async () => record(9));
  const adapter = createPiDurableThreadListAdapter(client({ listConversations: list, listMetadata, createConversation: create }), 1);
  const first = await adapter.list();
  expect(first.threads).toEqual([{ remoteId: "2", title: "Title 2", status: "regular" }]);
  expect(listMetadata).toHaveBeenNthCalledWith(1, [2]);
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenNthCalledWith(1, { order: "descending" }, 1, undefined);
  const second = await adapter.list({ after: first.nextCursor });
  expect(second.threads.map((item) => item.remoteId)).toEqual(["8"]);
  expect(listMetadata).toHaveBeenNthCalledWith(2, [8]);
  expect(list).toHaveBeenNthCalledWith(2, { order: "descending" }, 1, { after: 2 });
  expect(create).not.toHaveBeenCalled();
  expect(await adapter.initialize("draft-id")).toEqual({ remoteId: "9" });
  expect(create).toHaveBeenCalledOnce();
});

it.each(["archive", "delete"] as const)("rejects unsupported %s without changing metadata", async (operation) => {
  const updateMetadata = vi.fn();
  const adapter = createPiDurableThreadListAdapter(client({ updateMetadata }));
  await expect(adapter[operation]!("2")).rejects.toThrow(/Pi Durable does not support/);
  expect(updateMetadata).not.toHaveBeenCalled();
});

it("keeps both edit operations on the returned fork while another conversation receives input", async () => {
  let finishWrite!: () => void;
  const write = new Promise<void>((resolve) => { finishWrite = resolve; });
  const submitted: { id: ConversationId; type: string }[] = [];
  const shared = client({
    fork: async () => record(2),
    submit: async (destination, draft) => {
      submitted.push({ id: destination, type: draft.type });
      if (draft.type === "write") await write;
      return { id: 10, conversationId: destination, type: draft.type, status: "queued" } as SubmissionRecord;
    },
  });
  const source = new PiDurableConversation(shared, id(1));
  const other = new PiDurableConversation(shared, id(3));
  const edit = source.edit({ sourceId: "entry:4:0", content: [{ type: "text", text: "Revised question" }], attachments: [] } as unknown as AppendMessage);
  await expect.poll(() => submitted).toEqual([{ id: 2, type: "write" }]);
  await other.submit({ type: "input", content: "Other conversation" });
  finishWrite();
  expect((await edit).id).toBe(2);
  expect(submitted).toEqual([{ id: 2, type: "write" }, { id: 3, type: "input" }, { id: 2, type: "continue" }]);
});
