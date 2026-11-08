import { expect } from "vitest";
import { PiDurableConversation } from "../packages/adapter/src/conversation.js";
import { startApiServer } from "./support/api-server.js";
import { observedMessages, test } from "./support/fixtures.js";

test("reloading a synthetic run failure continues the same native conversation", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  const record = await host.client.createConversation();
  const conversation = new PiDurableConversation(host.client, record.id);
  try {
    await host.client.configure(record.id, { model: null });
    conversation.start();
    await conversation.submit({ type: "input", content: "Recover this original request" });
    await expect.poll(() => observedMessages(conversation).at(-1)?.id).toMatch(/^failure:/);
    const failure = observedMessages(conversation).at(-1)!;
    const originalHistory = await host.client.entries(record.id, { order: "ascending" }, 100);

    await host.client.configure(record.id, { model: { provider: "faux", modelId: "demo" } });
    const destination = await conversation.regenerate(null, failure.id);

    expect(destination.id).toBe(record.id);
    await expect.poll(() => observedMessages(conversation).at(-1)).toMatchObject({
      role: "assistant",
      status: { type: "complete" },
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Recover this original request") })]),
    });
    expect(observedMessages(conversation).some((message) => message.id === failure.id)).toBe(false);
    expect((await host.client.listConversations()).items.map((item) => item.id)).toEqual([record.id]);
    const history = await host.client.entries(record.id, { order: "ascending" }, 100);
    expect(history.items.slice(0, originalHistory.items.length)).toEqual(originalHistory.items);
    expect(history.items.filter((item) => item.kind === "pi.user")).toHaveLength(1);
    expect(history.items.filter((item) => item.kind === "assistant-ui.context-edit")).toHaveLength(0);
  } finally {
    conversation.stop();
    await host.close();
  }
});
