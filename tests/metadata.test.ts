import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { expect } from "vitest";
import { openLocalPiHost } from "../apps/demo/server/host.js";
import {
  ConversationMetadataDoc,
  getConversationMetadata,
  initializeConversationMetadata,
  listConversationMetadata,
  setConversationFeedback,
  updateConversationMetadata,
} from "../apps/demo/server/metadata.js";
import { test } from "./support/fixtures.js";

const context = BACKGROUND_CONTEXT;
const ownership = { kind: "ownerless" } as const;

test("presentation metadata survives native SQLite reopen without changing the conversation transcript", async ({ dataDirectory }) => {
  let piHost = await openLocalPiHost({ dataDirectory });
  let closed = false;
  try {
    const conversation = await piHost.harness.createConversation({
      ownership,
      agent: piHost.defaultAgent,
      init: (tx, id) => initializeConversationMetadata(tx, { id }),
    }, context);
    const submission = await conversation.submit({ type: "input", content: "Remember the original answer" }, context);
    const result = await submission.wait(context);
    if (result.status !== "done" || result.type !== "input") throw new Error("Expected a native answer.");
    const before = await conversation.entries({ order: "ascending" }, 100, undefined, context);

    await updateConversationMetadata(piHost.harness, conversation.id, {
      title: "My native conversation",
      archived: true,
      suggestions: ["Continue the same task"],
    }, context);
    const expected = await setConversationFeedback(piHost.harness, conversation.id, result.answer, "positive", context);
    expect(expected).toEqual({
      title: "My native conversation",
      archived: true,
      suggestions: ["Continue the same task"],
      feedback: { [result.answer]: "positive" },
    });
    const watch = await piHost.harness.watchDoc(ConversationMetadataDoc, conversation.id, context);
    if (!watch) throw new Error("Expected a native presentation document.");
    try {
      expect(watch.value).toEqual(expected);
    } finally {
      await watch.stop();
    }
    expect(await conversation.entries({ order: "ascending" }, 100, undefined, context)).toEqual(before);

    await piHost.close();
    closed = true;
    piHost = await openLocalPiHost({ dataDirectory });
    closed = false;
    expect(await getConversationMetadata(piHost.harness, conversation.id, context)).toEqual(expected);
    const records = await piHost.harness.commit((tx) => tx.scanConversations({}, 100), context);
    expect(await listConversationMetadata(piHost.harness, records.items, context)).toEqual([{ id: conversation.id, ...expected }]);
    const reopened = await piHost.harness.conversation(conversation.id, context);
    expect(await reopened!.entries({ order: "ascending" }, 100, undefined, context)).toEqual(before);

    const cleared = await setConversationFeedback(piHost.harness, conversation.id, result.answer, null, context);
    expect(cleared.feedback).toEqual({});
    expect(cleared.title).toBe(expected.title);
    expect(cleared.archived).toBe(true);
  } finally {
    if (!closed) await piHost.close();
  }
});

test("native forks start with fresh presentation metadata and keep feedback local even for inherited entries", async ({ dataDirectory }) => {
  const piHost = await openLocalPiHost({ dataDirectory });
  try {
    const parent = await piHost.harness.createConversation({
      ownership,
      agent: piHost.defaultAgent,
      init: (tx, id) => initializeConversationMetadata(tx, { id }),
    }, context);
    const result = await (await parent.submit({ type: "input", content: "An answer inherited by a fork" }, context)).wait(context);
    if (result.status !== "done" || result.type !== "input") throw new Error("Expected a native answer.");
    await updateConversationMetadata(piHost.harness, parent.id, { title: "Parent", archived: true }, context);
    await setConversationFeedback(piHost.harness, parent.id, result.answer, "positive", context);

    const unrelated = await piHost.harness.createConversation({ ownership, agent: piHost.defaultAgent }, context);
    await expect(setConversationFeedback(piHost.harness, unrelated.id, result.answer, "negative", context)).rejects.toThrow("Feedback entry not found in this conversation.");

    const fork = await parent.fork(result.answer, { ownership, init: (tx, id) => initializeConversationMetadata(tx, { id }) }, context);
    expect(await getConversationMetadata(piHost.harness, fork.id, context)).toMatchObject({ title: null, archived: false, feedback: {} });
    expect(await getConversationMetadata(piHost.harness, parent.id, context)).toMatchObject({ title: "Parent", archived: true, feedback: { [result.answer]: "positive" } });
    expect(await setConversationFeedback(piHost.harness, fork.id, result.answer, "negative", context)).toMatchObject({ feedback: { [result.answer]: "negative" } });
    expect((await getConversationMetadata(piHost.harness, parent.id, context)).feedback).toEqual({ [result.answer]: "positive" });

    await parent.reset(undefined, context);
    expect(await getConversationMetadata(piHost.harness, parent.id, context)).toMatchObject({ title: "Parent", archived: true, feedback: { [result.answer]: "positive" } });
  } finally {
    await piHost.close();
  }
});

test("older conversations read initial metadata without creating a document, then create it on update", async ({ dataDirectory }) => {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dataDirectory, "older.sqlite")), {
    models: createModels(),
    registry: createRegistry(),
  }, context);
  try {
    const conversation = await harness.createConversation({ ownership }, context);
    expect(await harness.snapshot(ConversationMetadataDoc, conversation.id, context)).toBeUndefined();
    expect(await getConversationMetadata(harness, conversation.id, context)).toMatchObject({ title: null, archived: false, feedback: {} });
    expect(await harness.snapshot(ConversationMetadataDoc, conversation.id, context)).toBeUndefined();

    await updateConversationMetadata(harness, conversation.id, { title: "Backfilled on write" }, context);
    expect(await harness.snapshot(ConversationMetadataDoc, conversation.id, context)).toMatchObject({ title: "Backfilled on write" });
    await expect(getConversationMetadata(harness, 99999 as ConversationId, context)).rejects.toThrow("Conversation not found.");
  } finally {
    await harness.close(context);
  }
});
