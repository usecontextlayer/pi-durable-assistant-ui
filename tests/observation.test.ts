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
