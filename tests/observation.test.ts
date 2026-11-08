import { expect } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHttpPiDurableClient } from "../packages/adapter/src/client.js";
import { PiDurableConversation } from "../packages/adapter/src/conversation.js";
import { test } from "./support/fixtures.js";
import { startApiServer } from "./support/api-server.js";

test("native metadata changes reach independently connected HTTP observers without transcript entries", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  const record = await host.client.createConversation();
  const first = new PiDurableConversation(host.client, record.id);
  const second = new PiDurableConversation(createHttpPiDurableClient({ baseUrl: host.baseUrl }), record.id);
  try {
    first.start();
    second.start();
    await expect.poll(() => Boolean(first.getSnapshot().view && second.getSnapshot().view)).toBe(true);
    await host.client.updateMetadata(record.id, { title: "Live native title" });
    await expect.poll(() => first.getSnapshot().metadata.title).toBe("Live native title");
    await expect.poll(() => second.getSnapshot().metadata.title).toBe("Live native title");
    expect((await host.client.entries(record.id, {}, 100)).items).toEqual([]);
  } finally {
    first.stop(); second.stop();
    await host.close();
  }
});

test("reload waits for initial history and metadata, then continues observing", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  const record = await host.client.createConversation();
  let releaseMetadata!: () => void;
  const metadataReady = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  const conversation = new PiDurableConversation({
    ...host.client,
    watchMetadata: async (id, signal) => {
      const watch = await host.client.watchMetadata!(id, signal);
      await metadataReady;
      return watch;
    },
  }, record.id);
  try {
    await host.client.updateMetadata(record.id, { title: "Before reload" });
    let reloaded = false;
    const reload = conversation.reload().then(() => { reloaded = true; });
    await expect.poll(() => Boolean(conversation.getSnapshot().view)).toBe(true);
    expect(reloaded).toBe(false);

    releaseMetadata();
    await reload;
    expect(conversation.getSnapshot().metadata.title).toBe("Before reload");
    expect(conversation.getSnapshot().isLoading).toBe(false);
    await host.client.updateMetadata(record.id, { title: "After reload" });
    await expect.poll(() => conversation.getSnapshot().metadata.title).toBe("After reload");

    conversation.stop();
    await host.client.updateMetadata(record.id, { title: "While disconnected" });
    await conversation.reload();
    expect(conversation.getSnapshot().metadata.title).toBe("While disconnected");
  } finally {
    releaseMetadata();
    conversation.stop();
    await host.close();
  }
});

test("reload rejects native acquisition failures and exposes the error in state", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  const conversation = new PiDurableConversation(host.client, 999999 as ConversationId);
  try {
    await expect(conversation.reload()).rejects.toThrow("Conversation not found.");
    expect(conversation.getSnapshot().error?.message).toBe("Conversation not found.");
    expect(conversation.getSnapshot().isLoading).toBe(false);
  } finally {
    conversation.stop();
    await host.close();
  }
});

test("unknown HTTP watch acquisition rejects and native source closure ends the logical watch", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  try {
    await expect(host.client.watch(999999 as ConversationId)).rejects.toThrow("Conversation not found.");
    const conversation = await host.client.createConversation();
    const watch = await host.client.watch(conversation.id);
    watch.start(async () => {});
    await host.piHost.harness.close(BACKGROUND_CONTEXT);
    await expect(watch.closed).resolves.toEqual({ kind: "ended" });
  } finally {
    await host.close();
  }
});

test("HTTP rejects foreign browser configuration changes", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  try {
    const conversation = await host.client.createConversation();
    const before = await host.client.getConversationView(conversation.id);
    const response = await fetch(`${host.baseUrl}/conversations/${conversation.id}/configure`, {
      method: "POST", headers: { "Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ cwd: "/private/tmp/foreign-request" }),
    });
    expect(response.status).toBe(403);
    expect((await host.client.getConversationView(conversation.id)).docs["pi.agent"]).toEqual(before.docs["pi.agent"]);
  } finally {
    await host.close();
  }
});

test("HTTP rejects custom archive patches rather than storing archive metadata", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  try {
    const conversation = await host.client.createConversation();
    await expect(host.client.updateMetadata(conversation.id, { archived: true } as never)).rejects.toThrow("Pi Durable does not support archiving conversations.");
    expect(await host.client.getMetadata(conversation.id)).not.toHaveProperty("archived");
  } finally {
    await host.close();
  }
});
