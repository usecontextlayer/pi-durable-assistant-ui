import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect } from "vitest";
import { openLocalPiHost } from "../apps/demo/server/host.js";
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
