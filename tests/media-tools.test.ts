import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { PiRuntimeStore } from "../packages/adapter/src/store.js";
import type { LocalUploadResult } from "../apps/demo/server/env.js";
import { startApiServer } from "./support/api-server.js";
import { answered, test } from "./support/fixtures.js";

function projectedTools(store: PiRuntimeStore) {
  return store.getSnapshot().messages.flatMap((message) => typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "tool-call"));
}

test("an uploaded file is retrievable and readable by Pi's native file tool", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  try {
    const uploadResponse = await fetch(`${host.baseUrl}/files?name=context.txt`, { method: "POST", headers: { "content-type": "text/plain" }, body: "Uploaded content reaches the native read tool." });
    const uploadResult = await uploadResponse.json() as LocalUploadResult;
    expect(uploadResult.content).toEqual([{ type: "text", text: `Uploaded file: context.txt\nThe file is available to the native file tools at ${uploadResult.path}` }]);
    const download = await fetch(new URL(uploadResult.url, host.baseUrl));
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("Uploaded content reaches the native read tool.");

    const conversation = await host.client.createConversation();
    const result = await answered(host.client, await host.client.submit(conversation.id, { type: "input", content: `/read ${uploadResult.path}` }));
    const history = await host.client.entries(conversation.id, { order: "ascending" }, 100);
    expect(JSON.stringify(history.items.find((entry) => entry.id === result.answer))).toContain("Uploaded content reaches the native read tool.");
    expect(history.items.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult")).toMatchObject([{ toolName: "read", isError: false }]);
  } finally {
    await host.close();
  }
});

test("native write, read and edit tools change the working file and project their matching results", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  const store = new PiRuntimeStore(host.client);
  try {
    store.start();
    const conversation = await store.createConversation();
    await answered(host.client, await store.submit({ type: "input", content: "/files" }));
    expect(await readFile(join(host.piHost.paths.workspacePath, "demo-note.txt"), "utf8")).toBe("Edited through Pi's native tool.\n");
    await expect.poll(() => projectedTools(store).map((tool) => tool.toolName)).toEqual(["write", "read", "edit", "read"]);
    await expect.poll(() => store.getSnapshot().isRunning).toBe(false);
    const tools = projectedTools(store);
    expect(tools.map((tool) => tool.toolName)).toEqual(["write", "read", "edit", "read"]);
    expect(tools.every((tool) => tool.result !== undefined && tool.isError === false)).toBe(true);
    expect((await host.client.entries(conversation.id, {}, 100)).items.some((entry) => entry.kind === "pi.tool-result")).toBe(true);
  } finally {
    store.stop();
    await host.close();
  }
});

test.for([
  ["/parallel", ["First parallel result", "Second parallel result"]],
  ["/nested", ["First nested call", "Second nested call"]],
  ["/tool-error", ["Intentional tool failure"]],
] as const)("%s exposes actual native tool results", async ([command, expected], { dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  try {
    const conversation = await host.client.createConversation();
    await answered(host.client, await host.client.submit(conversation.id, { type: "input", content: command }));
    const history = await host.client.entries(conversation.id, {}, 100);
    const results = history.items.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
    for (const text of expected) expect(JSON.stringify(results)).toContain(text);
    if (command === "/tool-error") expect(results).toMatchObject([{ toolName: "bash", isError: true }]);
  } finally {
    await host.close();
  }
});

test("image attachments and image tool results retain their native media content", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  const store = new PiRuntimeStore(host.client);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1kAAAAASUVORK5CYII=";
  try {
    const uploadResponse = await fetch(`${host.baseUrl}/files?name=pixel.png`, { method: "POST", headers: { "content-type": "image/png" }, body: Buffer.from(png, "base64") });
    const uploadResult = await uploadResponse.json() as LocalUploadResult;
    expect(uploadResult.content).toEqual([{ type: "image", data: png, mimeType: "image/png" }]);
    const download = await fetch(new URL(uploadResult.url, host.baseUrl));
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await download.arrayBuffer()).toString("base64")).toBe(png);
    store.start();
    const conversation = await store.createConversation();
    const input = await answered(host.client, await store.submit({ type: "input", content: uploadResult.content }));
    const inputHistory = await host.client.entries(conversation.id, { order: "ascending" }, 100);
    expect(inputHistory.items.find((entry) => entry.id === input.entry)?.model).toMatchObject([{ role: "user", content: [{ type: "image", data: png, mimeType: "image/png" }] }]);
    expect(JSON.stringify(inputHistory.items.find((entry) => entry.id === input.answer))).toContain("Pi received 1 native image input block(s)");

    await answered(host.client, await store.submit({ type: "input", content: "/image" }));
    await expect.poll(() => projectedTools(store).find((tool) => tool.toolName === "demo_image")?.modelContent).toContainEqual({ type: "file", mediaType: "image/png", data: png });
    const history = await host.client.entries(conversation.id, {}, 100);
    const imageResult = history.items.flatMap((entry) => entry.model ?? []).find((message) => message.role === "toolResult" && message.toolName === "demo_image");
    expect(imageResult).toMatchObject({ content: [{ type: "text" }, { type: "image", mimeType: "image/png", data: png }] });
  } finally {
    store.stop();
    await host.close();
  }
});

test("native tool details stream before settling to the final result", async ({ dataDirectory }) => {
  const host = await startApiServer(dataDirectory);
  const store = new PiRuntimeStore(host.client);
  const progress: number[] = [];
  const unsubscribe = store.subscribe(() => {
    const tool = projectedTools(store).find((item) => item.toolName === "demo_progress");
    const result = tool?.result;
    if (tool?.isPreliminary && result && typeof result === "object" && "completed" in result && typeof result.completed === "number" && result.completed < 5) {
      progress.push(result.completed);
    }
  });
  try {
    store.start();
    await store.createConversation();
    await answered(host.client, await store.submit({ type: "input", content: "/progress" }));
    await expect.poll(() => projectedTools(store).find((tool) => tool.toolName === "demo_progress")?.isPreliminary).toBe(false);
    expect(progress.length).toBeGreaterThan(0);
    expect(projectedTools(store).find((tool) => tool.toolName === "demo_progress")?.result).toEqual({ completed: 5, total: 5 });
  } finally {
    unsubscribe();
    store.stop();
    await host.close();
  }
});
