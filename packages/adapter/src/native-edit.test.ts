import { expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  ConversationTranscript,
  Harness,
  MemoryStorage,
  createRegistry,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
} from "@earendil-works/pi-durable";
import type { AppendMessage } from "@assistant-ui/react";
import type { PiDurableClient } from "./client.js";
import { PiDurableConversation } from "./conversation.js";
import { projectConversation } from "./projection.js";

it("edits the first input through native fork/context-edit while retaining original history", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  const input = await conversation.submit({ type: "write", entry: { kind: "test.input", model: [{ role: "user", content: "Original question", timestamp: 1 }] } }, context);
  const inputRecord = await input.status(context);
  if (inputRecord.status !== "done" || inputRecord.entry === undefined) throw new Error("Input did not commit");

  async function get(id: ConversationId): Promise<Conversation> {
    const found = await harness.conversation(id, context);
    if (!found) throw new Error(`Missing conversation ${id}`);
    return found;
  }
  async function record(found: Conversation): Promise<ConversationRecord> {
    const value = await harness.commit((tx) => tx.conversation(found.id), context);
    if (!value) throw new Error("Missing conversation record");
    return value;
  }
  const client: PiDurableClient = {
    listConversations: (query = {}, limit = 100, cursor) => harness.commit((tx) => tx.scanConversations(query, limit, cursor), context),
    createConversation: async (options = { ownership: { kind: "ownerless" } }) => record(await harness.createConversation({ ownership: options.ownership }, context)),
    getConversationView: async (id) => { const watch = await (await get(id)).watch(context); const value = watch.value; await watch.stop(); return value; },
    entries: async (id, query, limit, cursor) => (await get(id)).entries(query, limit, cursor, context),
    submit: async (id, draft) => (await (await get(id)).submit(draft, context)).status(context),
    getSubmission: async (id) => { const found = await harness.submission(id, context); if (!found) throw new Error("Missing submission"); return found.status(context); },
    fork: async (id, at, options = { ownership: { kind: "ownerless" } }) => record(await (await get(id)).fork(at, { ownership: options.ownership }, context)),
    watch: () => { throw new Error("This native operation test does not start browser observation"); },
  };
  const store = new PiDurableConversation(client, conversation.id);
  try {
    const createdFork = await store.edit({ sourceId: `entry:${inputRecord.entry}:0`, content: [{ type: "text", text: "Revised question" }], attachments: [] } as unknown as AppendMessage);
    const fork = await get(createdFork.id);
    await fork.waitForIdle(context);
    expect((await conversation.context(context)).messages).toContainEqual(expect.objectContaining({ role: "user", content: "Original question" }));
    expect((await fork.context(context)).messages).toContainEqual(expect.objectContaining({ role: "user", content: [{ type: "text", text: "Revised question" }] }));
    expect((await record(fork)).parent).toEqual({ conversationId: conversation.id, at: inputRecord.entry });

    const raw = await fork.entries({}, 100, undefined, context);
    expect(raw.items.find((item) => item.id === inputRecord.entry)?.model?.[0]).toMatchObject({ content: "Original question" });
    const watch = await fork.watch(context);
    const transcript = new ConversationTranscript((query, limit, ctx) => fork.entries(query, limit, undefined, ctx));
    const projected = projectConversation(transcript.merge(watch.value));
    expect(projected.find((message) => message.role === "user")?.content).toEqual([{ type: "text", text: "Revised question" }]);
    await watch.stop();
  } finally {
    await harness.close(context);
  }
});
