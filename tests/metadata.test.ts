import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { expect } from "vitest";
import { openLocalPiHost } from "../apps/demo/server/host.js";
import { createLocalPiDurableClient } from "../apps/demo/server/local-client.js";
import {
  ConversationMetadataDoc,
  getConversationMetadata,
  listConversationMetadata,
  setConversationFeedback,
  updateConversationMetadata,
} from "../apps/demo/server/metadata.js";
import { test } from "./support/fixtures.js";

const context = BACKGROUND_CONTEXT;
const ownership = { kind: "ownerless" } as const;

test("opening an existing demo upgrades legacy metadata and initializes missing documents", async ({ dataDirectory }) => {
  const LegacyPresentationDoc = defineDoc({
    ...ConversationMetadataDoc.definition,
    kind: "demo.presentation",
    history: "latest",
    fork: "initial",
    initial: () => ({ ...ConversationMetadataDoc.definition.initial(), archived: false }),
  });
  let host = await openLocalPiHost({ dataDirectory });
  let closed = false;
  try {
    const legacy = await host.harness.createConversation({ ownership, agent: host.defaultAgent }, context);
    const missing = await host.harness.createConversation({ ownership, agent: host.defaultAgent }, context);
    const current = await host.harness.createConversation({ ownership, agent: host.defaultAgent }, context);
    const answer = await (await legacy.submit({ type: "input", content: "Preserve this answer and its feedback" }, context)).wait(context);
    if (answer.status !== "done" || answer.type !== "input") throw new Error("Expected a native answer.");
    const before = await legacy.entries({}, 100, undefined, context);
    const expected = { title: "Legacy title", feedback: { [answer.answer]: "positive" as const }, suggestions: ["Keep going"] };
    await host.harness.commit(async (tx) => {
      await tx.retireDoc(ConversationMetadataDoc, legacy.id);
      await tx.retireDoc(ConversationMetadataDoc, missing.id);
      Object.assign(await tx.doc(LegacyPresentationDoc, legacy.id), expected, { archived: true });
      (await tx.doc(ConversationMetadataDoc, current.id)).title = "Current title";
      (await tx.doc(LegacyPresentationDoc, current.id)).title = "Superseded title";
    }, context);
    await host.close();
    closed = true;

    host = await openLocalPiHost({ dataDirectory });
    closed = false;
    const client = createLocalPiDurableClient(host);
    const page = await client.listMetadata([legacy.id, missing.id, current.id]);
    expect(page[String(legacy.id)]).toEqual(expected);
    expect(page[String(missing.id)]).toMatchObject({ title: null, feedback: {} });
    expect(page[String(current.id)]?.title).toBe("Current title");
    expect(await host.harness.snapshot(LegacyPresentationDoc, legacy.id, context)).toBeUndefined();
    expect(await (await host.harness.conversation(legacy.id, context))!.entries({}, 100, undefined, context)).toEqual(before);

    const watch = await client.watchMetadata(legacy.id);
    try {
      expect(watch.value).toEqual(expected);
      let title = watch.value.title;
      watch.start(async (change) => { if (change.kind === "value") title = change.value.title; });
      await client.updateMetadata(legacy.id, { title: "Updated after upgrade" });
      await expect.poll(() => title).toBe("Updated after upgrade");
    } finally {
      await watch.stop();
    }
    await host.close();
    closed = true;
    host = await openLocalPiHost({ dataDirectory });
    closed = false;
    expect(await getConversationMetadata(host.harness, legacy.id, context)).toEqual({ ...expected, title: "Updated after upgrade" });
  } finally {
    if (!closed) await host.close();
  }
});

test("metadata survives native SQLite reopen without changing the conversation transcript", async ({ dataDirectory }) => {
  let piHost = await openLocalPiHost({ dataDirectory });
  let closed = false;
  try {
    const conversation = await piHost.harness.createConversation({
      ownership,
      agent: piHost.defaultAgent,
    }, context);
    expect(await piHost.harness.snapshot(ConversationMetadataDoc, conversation.id, context)).toMatchObject({ title: null, feedback: {} });
    const submission = await conversation.submit({ type: "input", content: "Remember the original answer" }, context);
    const result = await submission.wait(context);
    if (result.status !== "done" || result.type !== "input") throw new Error("Expected a native answer.");
    const before = await conversation.entries({ order: "ascending" }, 100, undefined, context);

    await updateConversationMetadata(piHost.harness, conversation.id, {
      title: "My native conversation",
      suggestions: ["Continue the same task"],
    }, context);
    const expected = await setConversationFeedback(piHost.harness, conversation.id, result.answer, "positive", context);
    expect(expected).toEqual({
      title: "My native conversation",
      suggestions: ["Continue the same task"],
      feedback: { [result.answer]: "positive" },
    });
    const watch = await piHost.harness.watchDoc(ConversationMetadataDoc, conversation.id, context);
    if (!watch) throw new Error("Expected a native metadata document.");
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
    expect(await listConversationMetadata(piHost.harness, [conversation.id], context)).toEqual({ [String(conversation.id)]: expected });
    const reopened = await piHost.harness.conversation(conversation.id, context);
    expect(await reopened!.entries({ order: "ascending" }, 100, undefined, context)).toEqual(before);

    const cleared = await setConversationFeedback(piHost.harness, conversation.id, result.answer, null, context);
    expect(cleared.feedback).toEqual({});
    expect(cleared.title).toBe(expected.title);
    expect(cleared).not.toHaveProperty("archived");
  } finally {
    if (!closed) await piHost.close();
  }
});

test("native forks start with fresh metadata and keep feedback local even for inherited entries", async ({ dataDirectory }) => {
  const piHost = await openLocalPiHost({ dataDirectory });
  try {
    const parent = await piHost.harness.createConversation({
      ownership,
      agent: piHost.defaultAgent,
    }, context);
    const result = await (await parent.submit({ type: "input", content: "An answer inherited by a fork" }, context)).wait(context);
    if (result.status !== "done" || result.type !== "input") throw new Error("Expected a native answer.");
    await updateConversationMetadata(piHost.harness, parent.id, { title: "Parent" }, context);
    await setConversationFeedback(piHost.harness, parent.id, result.answer, "positive", context);

    const unrelated = await piHost.harness.createConversation({ ownership, agent: piHost.defaultAgent }, context);
    await expect(setConversationFeedback(piHost.harness, unrelated.id, result.answer, "negative", context)).rejects.toThrow("Feedback entry not found in this conversation.");

    const fork = await parent.fork(result.answer, { ownership }, context);
    expect(await getConversationMetadata(piHost.harness, fork.id, context)).toMatchObject({ title: null, feedback: {} });
    expect(await getConversationMetadata(piHost.harness, parent.id, context)).toMatchObject({ title: "Parent", feedback: { [result.answer]: "positive" } });
    expect(await setConversationFeedback(piHost.harness, fork.id, result.answer, "negative", context)).toMatchObject({ feedback: { [result.answer]: "negative" } });
    expect((await getConversationMetadata(piHost.harness, parent.id, context)).feedback).toEqual({ [result.answer]: "positive" });

    await parent.reset(undefined, context);
    expect(await getConversationMetadata(piHost.harness, parent.id, context)).toMatchObject({ title: "Parent", feedback: { [result.answer]: "positive" } });
  } finally {
    await piHost.close();
  }
});
