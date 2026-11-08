import { expect } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PiRuntimeStore } from "../packages/adapter/src/store.js";
import { projectConversation } from "../packages/adapter/src/projection.js";
import { isForegroundRunning } from "../packages/adapter/src/projection.js";
import { createLocalPiClient } from "../apps/demo/server/local-client.js";
import { openLocalPiHost } from "../apps/demo/server/host.js";
import { answered, test } from "./support/fixtures.js";
import { startApiServer } from "./support/api-server.js";

test("the unchanged adapter store uses a direct native host without an HTTP server", async ({ dataDirectory }) => {
  const piHost = await openLocalPiHost({ dataDirectory, tokensPerSecond: 100_000 });
  const client = createLocalPiClient(piHost);
  const store = new PiRuntimeStore(client);
  try {
    store.start();
    const first = await store.createConversation();
    const submission = await store.submit({ type: "input", content: "Portable native conversation" });
    const answer = await answered(client, submission);
    await expect.poll(() => store.getSnapshot().messages.some((message) => message.id === `entry:${answer.answer}:0`)).toBe(true);

    const native = await piHost.harness.commit((tx) => tx.conversation(first.id), BACKGROUND_CONTEXT);
    expect(native).toEqual(first);
    expect(store.getSnapshot().selectedId).toBe(first.id);
    expect(store.getSnapshot().messages).toEqual(projectConversation(store.getSnapshot().view!));
    expect(JSON.stringify(store.getSnapshot().messages)).toContain("Portable native conversation");

    const second = await store.createConversation();
    expect(second.id).not.toBe(first.id);
    await expect.poll(() => store.getSnapshot().selectedId).toBe(second.id);
    store.selectConversation(first.id);
    await expect.poll(() => store.getSnapshot().isLoading).toBe(false);
    expect(store.getSnapshot().selectedId).toBe(first.id);
    expect(JSON.stringify(store.getSnapshot().messages)).toContain("Portable native conversation");
  } finally {
    store.stop();
    await piHost.close();
  }
});

test("native background children keep running after the parent answers and report back once", async ({ dataDirectory }) => {
  const piHost = await openLocalPiHost({ dataDirectory, tokensPerSecond: 100_000 });
  const client = createLocalPiClient(piHost);
  try {
    const parent = await client.createConversation();
    await answered(client, await client.submit(parent.id, { type: "input", content: "/background" }));
    const children = await client.listConversations({ ownerConversationId: parent.id });
    expect(children.items).toHaveLength(1);
    const child = children.items[0]!;
    expect(isForegroundRunning(await client.getConversationView(parent.id))).toBe(false);
    expect(isForegroundRunning(await client.getConversationView(child.id))).toBe(true);
    await expect.poll(async () => (await client.entries(parent.id, {}, 100)).items.filter((entry) => entry.kind === "demo.background-report").length, { timeout: 5_000 }).toBe(1);
    await expect.poll(async () => isForegroundRunning(await client.getConversationView(parent.id))).toBe(false);
    expect(isForegroundRunning(await client.getConversationView(child.id))).toBe(false);
    expect((await piHost.harness.inspect(BACKGROUND_CONTEXT)).tasks).toHaveLength(0);
  } finally {
    await piHost.close();
  }
});

test("a native background task resumes after reopening without duplicating its child or report", async ({ dataDirectory }) => {
  let piHost = await openLocalPiHost({ dataDirectory, tokensPerSecond: 100_000 });
  let client = createLocalPiClient(piHost);
  const parent = await client.createConversation();
  await answered(client, await client.submit(parent.id, { type: "input", content: "/background" }));
  const child = (await client.listConversations({ ownerConversationId: parent.id })).items[0]!;
  expect(isForegroundRunning(await client.getConversationView(child.id))).toBe(true);
  await piHost.close();

  piHost = await openLocalPiHost({ dataDirectory, tokensPerSecond: 100_000 });
  client = createLocalPiClient(piHost);
  try {
    await piHost.harness.waitForTask(child.owner!.taskId, BACKGROUND_CONTEXT);
    expect((await client.listConversations({ ownerConversationId: parent.id })).items.map((record) => record.id)).toEqual([child.id]);
    expect((await client.entries(parent.id, {}, 100)).items.filter((entry) => entry.kind === "demo.background-report")).toHaveLength(1);
  } finally {
    await piHost.close();
  }
});

test("the direct binding preserves native paging and reconstructs state after SQLite reopen", async ({ dataDirectory }) => {
  let piHost = await openLocalPiHost({ dataDirectory, tokensPerSecond: 100_000 });
  let client = createLocalPiClient(piHost);
  const conversation = await client.createConversation();
  for (let index = 0; index < 115; index += 1) {
    await client.submit(conversation.id, {
      type: "write",
      entry: { kind: "portable.note", model: [{ role: "user", content: `Portable note ${index}`, timestamp: index }] },
    });
  }
  await piHost.close();
  piHost = await openLocalPiHost({ dataDirectory, tokensPerSecond: 100_000 });
  client = createLocalPiClient(piHost);
  const store = new PiRuntimeStore(client, { initialConversationId: conversation.id, pageSize: 30 });
  try {
    store.start();
    await expect.poll(() => store.getSnapshot().connection).toBe("connected");
    expect(store.getSnapshot().hasEarlier).toBe(true);
    while (store.getSnapshot().hasEarlier) await store.loadEarlier();
    expect(store.getSnapshot().messages).toHaveLength(115);
    expect(store.getSnapshot().messages[0]?.id).toMatch(/^entry:\d+:0$/);
    expect(JSON.stringify(store.getSnapshot().messages[0])).toContain("Portable note 0");
    expect(JSON.stringify(store.getSnapshot().messages.at(-1))).toContain("Portable note 114");
    expect(new Set(store.getSnapshot().messages.map((message) => message.id)).size).toBe(115);
  } finally {
    store.stop();
    await piHost.close();
  }
});

test("HTTP agent configuration resolves registered names and preserves Pi replacement and clearing semantics", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  try {
    const coding = host.piHost.registry.snapshot().tools().find(({ tool }) => tool.name === "bash")!.extension.name;
    const created = await host.client.createConversation({
      ownership: { kind: "ownerless" },
      agent: { extensions: [coding, "demo"], tools: ["bash"], modelTools: ["bash"], maxTurns: 3 },
    });
    expect((await host.client.getConversationView(created.id)).docs["pi.agent"]).toMatchObject({
      extensions: [coding, "demo"], tools: ["bash"], modelTools: ["bash"], maxTurns: 3,
    });
    await answered(host.client, await host.client.submit(created.id, { type: "input", content: "/tool" }));
    expect((await host.client.entries(created.id, {}, 100)).items.some((entry) => entry.kind === "pi.tool-result")).toBe(true);

    const patch = {
      extensions: { add: ["demo"], remove: [coding] },
      tools: { remove: ["bash"] },
      modelTools: { add: ["demo_image"], remove: ["read"] },
      thinkingLevel: "low" as const,
    };
    await host.client.configure!(created.id, patch);
    expect((await host.client.getConversationView(created.id)).docs["pi.agent"]).toMatchObject({ ...patch, maxTurns: 3 });

    const at = (await host.client.entries(created.id, { order: "descending" }, 1)).items[0]!.id;
    const fork = await host.client.fork!(created.id, at, { ownership: { kind: "ownerless" }, agent: { tools: ["read"], modelTools: ["read"] } });
    expect((await host.client.getConversationView(fork.id)).docs["pi.agent"]).toMatchObject({ tools: ["read"], modelTools: ["read"], maxTurns: 3 });

    await host.client.configure!(created.id, { extensions: null, tools: null, modelTools: null, maxTurns: null });
    const cleared = (await host.client.getConversationView(created.id)).docs["pi.agent"];
    expect(cleared).not.toHaveProperty("extensions");
    expect(cleared).not.toHaveProperty("tools");
    expect(cleared).not.toHaveProperty("modelTools");
    expect(cleared).not.toHaveProperty("maxTurns");
    expect(cleared).toHaveProperty("thinkingLevel", "low");
  } finally {
    await host.close();
  }
});
