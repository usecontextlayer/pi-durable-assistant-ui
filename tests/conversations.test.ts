import { expect } from "vitest";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiDurableClient } from "../packages/adapter/src/client.js";
import { conversationLiveState } from "../packages/adapter/src/projection.js";
import { PiDurableConversation } from "../packages/adapter/src/conversation.js";
import { startApiServer } from "./support/api-server.js";
import { observedMessages, isRunning, answered, settled, test } from "./support/fixtures.js";

test("native conversations keep distinct histories and submission answers after reopening SQLite", async ({ dataDirectory }) => {
  const first = await startApiServer(dataDirectory);
  const conversations = await Promise.all([first.client.createConversation(), first.client.createConversation()]);
  let answer: Awaited<ReturnType<typeof answered>>;
  let entries: Awaited<ReturnType<PiDurableClient["entries"]>>;
  try {
    expect(conversations[0]!.id).not.toBe(conversations[1]!.id);
    const submission = await first.client.submit(conversations[0]!.id, { type: "input", content: "Remember this local conversation" });
    answer = await answered(first.client, submission);
    expect(answer.conversationId).toBe(conversations[0]!.id);
    entries = await first.client.entries(conversations[0]!.id, { order: "ascending" }, 100);
    expect(entries.items.find((entry) => entry.id === answer.entry)?.kind).toBe("pi.user");
    const result = entries.items.find((entry) => entry.id === answer.answer);
    expect(result?.kind).toBe("pi.assistant");
    expect(JSON.stringify(result)).toContain("Remember this local conversation");
    expect((await first.client.entries(conversations[1]!.id, {}, 100)).items).toEqual([]);
  } finally {
    await first.close();
  }

  const reopened = await startApiServer(dataDirectory);
  try {
    expect((await reopened.client.listConversations()).items.map((item) => item.id).sort()).toEqual(conversations.map((item) => item.id).sort());
    expect(await reopened.client.entries(conversations[0]!.id, { order: "ascending" }, 100)).toEqual(entries!);
    expect(await reopened.client.getSubmission(answer!.id)).toEqual(answer!);
    expect((await reopened.client.entries(conversations[1]!.id, {}, 100)).items).toEqual([]);
  } finally {
    await reopened.close();
  }
});

test("disconnecting a live observer leaves its native submission running and reconnects to the answer", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory, { tokensPerSecond: 200 });
  const conversation = await host.client.createConversation();
  const store = new PiDurableConversation(host.client, conversation.id);
  try {
    store.start();
    await expect.poll(() => store.getSnapshot().connection).toBe("connected");
    const submission = await store.submit({ type: "input", content: "/long disconnect and return" });
    await expect.poll(() => isRunning(store)).toBe(true);
    await expect.poll(() => observedMessages(store).some((message) => message.role === "assistant")).toBe(true);
    store.stop();

    const answer = await answered(host.client, submission);
    store.start();
    await expect.poll(() => store.getSnapshot().view?.items.some((item) => item.kind === "entry" && item.entry.id === answer.answer)).toBe(true);
    await expect.poll(() => isRunning(store)).toBe(false);
    expect(JSON.stringify(observedMessages(store))).toContain("12. Native history keeps this paragraph");
    expect((await host.client.getSubmission(submission.id)).status).toBe("done");
  } finally {
    store.stop();
    await host.close();
  }
});

const slowToolResponse: FauxResponseFactory = (context) => {
  const latest = context.messages.at(-1);
  if (latest?.role === "user" && latest.content === "Start a slow tool") {
    return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1; printf 'Native tool completed'" }), { stopReason: "toolUse" });
  }
  const inputs = context.messages.filter((message) => message.role === "user").map((message) => message.content);
  return fauxAssistantMessage(JSON.stringify(inputs));
};

test("steers join the active run while follow-ups start the next run and withdrawn input stays out of history", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory, { response: slowToolResponse });
  try {
    const conversation = await host.client.createConversation();
    const initial = await host.client.submit(conversation.id, { type: "input", content: "Start a slow tool" });
    await expect.poll(async () => conversationLiveState(await host.client.getConversationView(conversation.id)).tools?.some((tool) => tool.status !== "done")).toBe(true);
    const followUp = await host.client.submit(conversation.id, { type: "input", content: "Run this after the answer", whenBusy: "followUp" });
    const steer = await host.client.submit(conversation.id, { type: "input", content: "Include this in the current answer", whenBusy: "steer" });
    const withdrawn = await host.client.submit(conversation.id, { type: "input", content: "This withdrawn input must never be placed", whenBusy: "followUp" });
    expect(followUp.status).toBe("queued");
    expect(steer.status).toBe("queued");
    expect(await host.client.abortSubmission!(withdrawn.id)).toBe("aborted");
    expect(await settled(host.client, withdrawn)).toMatchObject({ status: "unanswered", reason: "aborted" });

    const firstAnswer = await answered(host.client, initial);
    const steeredAnswer = await answered(host.client, steer);
    const nextAnswer = await answered(host.client, followUp);
    expect(steeredAnswer.answer).toBe(firstAnswer.answer);
    expect(nextAnswer.answer).not.toBe(firstAnswer.answer);
    expect(nextAnswer.entry).toBeGreaterThan(firstAnswer.answer);
    const history = await host.client.entries(conversation.id, { order: "ascending" }, 100);
    expect(JSON.stringify(history.items)).not.toContain("This withdrawn input must never be placed");
    const answer = history.items.find((entry) => entry.id === firstAnswer.answer);
    expect(JSON.stringify(answer)).toContain("Include this in the current answer");
    expect(JSON.stringify(answer)).not.toContain("Run this after the answer");
  } finally {
    await host.close();
  }
});

test("conversation abort settles active work and continue resumes its remaining context without another user entry", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory, { response: slowToolResponse });
  try {
    const conversation = await host.client.createConversation();
    const initial = await host.client.submit(conversation.id, { type: "input", content: "Start a slow tool" });
    await expect.poll(async () => conversationLiveState(await host.client.getConversationView(conversation.id)).tools?.some((tool) => tool.status !== "done")).toBe(true);
    await host.client.abort!(conversation.id);
    expect(await settled(host.client, initial)).toMatchObject({ status: "unanswered", reason: "aborted" });
    const continuation = await settled(host.client, await host.client.submit(conversation.id, { type: "continue" }));
    expect(continuation).toMatchObject({ type: "continue", status: "done" });
    const history = await host.client.entries(conversation.id, { order: "ascending" }, 100);
    expect(history.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    expect(JSON.stringify(history.items)).toContain("Start a slow tool");
    expect(conversationLiveState(await host.client.getConversationView(conversation.id)).run).toBeUndefined();
  } finally {
    await host.close();
  }
});

test("forked edits preserve ancestry and reset changes active context without deleting history", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory, { response: slowToolResponse });
  try {
    const original = await host.client.createConversation();
    const first = await answered(host.client, await host.client.submit(original.id, { type: "input", content: "Keep this original context" }));
    await answered(host.client, await host.client.submit(original.id, { type: "input", content: "Replace this later input" }));
    const originalHistory = await host.client.entries(original.id, { order: "ascending" }, 100);
    const fork = await host.client.fork!(original.id, first.answer);
    expect(fork.id).not.toBe(original.id);
    expect(fork.parent).toEqual({ conversationId: original.id, at: first.answer });
    expect(JSON.stringify((await host.client.context!(fork.id)).messages)).toContain("Keep this original context");
    expect(JSON.stringify((await host.client.context!(fork.id)).messages)).not.toContain("Replace this later input");
    await answered(host.client, await host.client.submit(fork.id, { type: "input", content: "Use this revised input" }));
    expect(await host.client.entries(original.id, { order: "ascending" }, 100)).toEqual(originalHistory);
    const forkHistory = await host.client.entries(fork.id, { order: "ascending" }, 100);

    await host.client.reset!(fork.id, "Continue from this handoff");
    const resetContext = await host.client.context!(fork.id);
    expect(resetContext.messages).toMatchObject([{ role: "user", content: "Continue from this handoff" }]);
    expect(resetContext.messages).toHaveLength(1);
    const resetHistory = await host.client.entries(fork.id, { order: "ascending" }, 100);
    expect(resetHistory.items.slice(0, forkHistory.items.length)).toEqual(forkHistory.items);
    expect(resetHistory.items.at(-1)?.kind).toBe("pi.reset");
    const resumed = await settled(host.client, await host.client.submit(fork.id, { type: "continue" }));
    expect(resumed).toMatchObject({ type: "continue", status: "done" });
    const resumedHistory = await host.client.entries(fork.id, { order: "ascending" }, 100);
    const lastAnswer = resumedHistory.items.findLast((entry) => entry.kind === "pi.assistant");
    expect(JSON.stringify(lastAnswer)).toContain("Continue from this handoff");
    expect(JSON.stringify(lastAnswer)).not.toContain("Keep this original context");
  } finally {
    await host.close();
  }
});

test("editing the first message and regenerating use native forks while retaining the source conversations", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory, { response: slowToolResponse });
  const original = await host.client.createConversation();
  const store = new PiDurableConversation(host.client, original.id);
  try {
    await answered(host.client, await host.client.submit(original.id, { type: "input", content: "Original first message" }));
    await answered(host.client, await host.client.submit(original.id, { type: "input", content: "Original later message" }));
    const originalHistory = await host.client.entries(original.id, { order: "ascending" }, 100);
    store.start();
    await expect.poll(() => observedMessages(store).length).toBe(4);
    const originalUser = observedMessages(store)[0]!;
    const edited = await store.edit({
      role: "user",
      sourceId: originalUser.id!,
      parentId: null,
      content: [{ type: "text", text: "Revised first message" }],
      attachments: [],
      createdAt: new Date(),
      metadata: { custom: {} },
      runConfig: undefined,
    });
    const editedId = edited.id;
    const editedStore = new PiDurableConversation(host.client, editedId);
    editedStore.start();
    expect(editedId).not.toBe(original.id);
    await expect.poll(async () => (await host.client.entries(editedId, {}, 100)).items.filter((entry) => entry.kind === "pi.assistant").length).toBe(1);
    await expect.poll(() => JSON.stringify(observedMessages(editedStore).at(-1))).toContain("Revised first message");
    await expect.poll(() => isRunning(editedStore)).toBe(false);
    const editedContext = await host.client.context!(editedId);
    expect(JSON.stringify(editedContext.messages)).toContain("Revised first message");
    expect(JSON.stringify(editedContext.messages)).not.toContain("Original first message");
    expect(JSON.stringify(editedContext.messages)).not.toContain("Original later message");
    expect(JSON.stringify(observedMessages(editedStore)[0])).toContain("Revised first message");
    expect(await host.client.entries(original.id, { order: "ascending" }, 100)).toEqual(originalHistory);
    const editedHistory = await host.client.entries(editedId, { order: "ascending" }, 100);
    const previousAnswer = editedHistory.items.findLast((entry) => entry.kind === "pi.assistant")!;

    const regenerated = await editedStore.regenerate(observedMessages(editedStore).find((message) => message.role === "user")!.id!);
    const regeneratedId = regenerated.id;
    expect(regeneratedId).not.toBe(editedId);
    await expect.poll(async () => (await host.client.entries(regeneratedId, {}, 100)).items.filter((entry) => entry.kind === "pi.assistant").length).toBe(2);
    expect((await host.client.getConversationView(regeneratedId)).conversation.parent).toEqual({ conversationId: editedId, at: previousAnswer.id });
    expect((await host.client.context!(regeneratedId)).messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(await host.client.entries(editedId, { order: "ascending" }, 100)).toEqual(editedHistory);
    expect(await host.client.entries(original.id, { order: "ascending" }, 100)).toEqual(originalHistory);
    editedStore.stop();
  } finally {
    store.stop();
    await host.close();
  }
});

test("manual compaction writes a native summary and preserves the complete stored history", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory, {
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    response: (context) => fauxAssistantMessage(getCurrentSystemPrompt(context.messages).includes("context summarization assistant")
      ? "Compacted native summary: keep the agreed decision."
      : "The latest answer remains available."),
  });
  try {
    const conversation = await host.client.createConversation();
    for (const content of ["Earlier detail to summarize", "The agreed decision", "Latest request"]) {
      await answered(host.client, await host.client.submit(conversation.id, { type: "input", content }));
    }
    const before = await host.client.entries(conversation.id, { order: "ascending" }, 100);
    const taskId = await host.client.compact!(conversation.id, "Keep the agreed decision");
    const task = await host.piHost.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    expect(task.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
    if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("Compaction did not complete");
    const submissionId = task.state.outcome.result.submissionId;
    expect(submissionId).toBeDefined();
    expect(await host.client.getSubmission(submissionId!)).toMatchObject({ type: "write", status: "done" });

    const after = await host.client.entries(conversation.id, { order: "ascending" }, 100);
    expect(after.items.slice(0, before.items.length)).toEqual(before.items);
    expect(after.items.at(-1)?.kind).toBe("pi.compaction");
    const context = await host.client.context!(conversation.id);
    expect(context.head?.kind).toBe("pi.compaction");
    expect(JSON.stringify(context.messages)).toContain("Compacted native summary: keep the agreed decision.");
    expect(JSON.stringify(context.messages)).not.toContain("Earlier detail to summarize");
    expect(JSON.stringify(context.messages)).toContain("The latest answer remains available.");
  } finally {
    await host.close();
  }
});

test("native context limits trigger automatic compaction without losing stored entries", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory, {
    settings: { compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 64, backgroundTokens: 0 } },
  });
  try {
    const provider = fauxProvider({ provider: "compact-fixture", models: [{ id: "compact", contextWindow: 2048, maxTokens: 256 }], tokensPerSecond: 100_000 });
    const response: FauxResponseFactory = (context) => fauxAssistantMessage(getCurrentSystemPrompt(context.messages).includes("context summarization assistant")
      ? "Automatically compacted prior facts."
      : "Acknowledged the latest facts.");
    provider.setResponses(Array.from({ length: 12 }, () => response));
    host.piHost.models.setProvider(provider.provider);
    const conversation = await host.client.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "compact-fixture", modelId: "compact" }, tools: [] } });
    const content = "A detailed fact to keep in the running conversation. ".repeat(45);
    for (let index = 1; index <= 3; index += 1) {
      await answered(host.client, await host.client.submit(conversation.id, { type: "input", content: `Round ${index}. ${content}` }));
    }
    const history = await host.client.entries(conversation.id, { order: "ascending" }, 100);
    expect(history.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(3);
    expect(history.items.some((entry) => entry.kind === "pi.compaction")).toBe(true);
    expect(JSON.stringify((await host.client.context!(conversation.id)).messages)).toContain("Automatically compacted prior facts.");
    expect(JSON.stringify(history.items)).toContain("Round 1.");
  } finally {
    await host.close();
  }
});

test("creation defaults leave existing configuration alone while registered instructions use current code", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory, { response: (context) => fauxAssistantMessage(getCurrentSystemPrompt(context.messages)) });
  try {
    Object.assign(host.piHost.defaultAgent, { maxTurns: 2 });
    const existing = await host.client.createConversation();
    host.piHost.registry.install(defineExtension({ name: "demo", sections: [section("preamble", () => "Instruction version one", { tag: false })] }));
    const first = await answered(host.client, await host.client.submit(existing.id, { type: "input", content: "Render instructions" }));
    const firstHistory = await host.client.entries(existing.id, { order: "ascending" }, 100);
    expect(JSON.stringify(firstHistory.items.find((entry) => entry.id === first.answer))).toContain("Instruction version one");

    Object.assign(host.piHost.defaultAgent, { maxTurns: 6 });
    const createdLater = await host.client.createConversation();
    expect((await host.client.getConversationView(existing.id)).docs["pi.agent"]).toMatchObject({ maxTurns: 2 });
    expect((await host.client.getConversationView(createdLater.id)).docs["pi.agent"]).toMatchObject({ maxTurns: 6 });
    await host.client.configure!(existing.id, { maxTurns: 4, thinkingLevel: "low" });
    expect((await host.client.getConversationView(existing.id)).docs["pi.agent"]).toMatchObject({ maxTurns: 4, thinkingLevel: "low" });
    expect((await host.client.getConversationView(createdLater.id)).docs["pi.agent"]).toMatchObject({ maxTurns: 6 });

    host.piHost.registry.install(defineExtension({ name: "demo", sections: [section("preamble", () => "Instruction version two", { tag: false })] }));
    const second = await answered(host.client, await host.client.submit(existing.id, { type: "input", content: "Render updated instructions" }));
    const updated = (await host.client.entries(existing.id, { order: "ascending" }, 100)).items.find((entry) => entry.id === second.answer);
    expect(JSON.stringify(updated)).toContain("Instruction version two");
    expect(JSON.stringify(updated)).not.toContain("Instruction version one");
  } finally {
    await host.close();
  }
});

test("the native transcript loads earlier pages beyond a bounded watch without losing live entries", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  const conversation = await host.client.createConversation();
  const store = new PiDurableConversation({
    ...host.client,
    watch: (id, options) => host.client.watch(id, { ...options, window: () => ({ min: 2, max: 4 }) }),
  }, conversation.id, 2);
  try {
    for (const content of ["First page", "Second page", "Third page", "Latest page"]) {
      await answered(host.client, await host.client.submit(conversation.id, { type: "input", content }));
    }
    const allEntries = (await host.client.entries(conversation.id, { order: "ascending" }, 100)).items;
    expect(allEntries.length).toBeGreaterThan(4);
    store.start();
    await expect.poll(() => (store.getSnapshot().view?.items[0]?.kind === "earlier")).toBe(true);
    expect(observedMessages(store)).toHaveLength(2);
    while ((store.getSnapshot().view?.items[0]?.kind === "earlier")) {
      const count = store.getSnapshot().view!.items.filter((item) => item.kind === "entry").length;
      await store.loadEarlier();
      expect(store.getSnapshot().view!.items.filter((item) => item.kind === "entry").length).toBeGreaterThan(count);
    }
    const expectedIds = allEntries.map((entry) => entry.id);
    expect(store.getSnapshot().view?.items.flatMap((item) => item.kind === "entry" ? [item.entry.id] : [])).toEqual(expectedIds);
    expect(observedMessages(store)).toHaveLength(8);

    const answer = await answered(host.client, await store.submit({ type: "input", content: "After loading history" }));
    await expect.poll(() => store.getSnapshot().view?.items.at(-1)).toMatchObject({ kind: "entry", entry: { id: answer.answer } });
    expect(store.getSnapshot().view?.items.slice(0, expectedIds.length).flatMap((item) => item.kind === "entry" ? [item.entry.id] : [])).toEqual(expectedIds);
  } finally {
    store.stop();
    await host.close();
  }
});
