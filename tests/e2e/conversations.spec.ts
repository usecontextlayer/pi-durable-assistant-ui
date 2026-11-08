import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { startDemoServer } from "../../apps/demo/server/dev.js";

const test = base.extend<{ streamingDemoUrl: string }, { demoUrl: string }>({
  demoUrl: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-ui-browser-"));
    const demo = await startDemoServer({ dataDirectory: directory, provider: "faux", port: 0 });
    try {
      await use(demo.url);
    } finally {
      await demo.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: "worker" }],
  streamingDemoUrl: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-ui-streaming-browser-"));
    const demo = await startDemoServer({ dataDirectory: directory, provider: "faux", tokensPerSecond: 50, port: 0 });
    try {
      await use(demo.url);
    } finally {
      await demo.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function createConversation(page: Page) {
  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/conversations") && candidate.request().method() === "POST" && candidate.status() === 201);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  const conversation = await (await response).json();
  const title = `Conversation ${conversation.id}`;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
  return title;
}

test("a person can create, switch and reopen native conversations", async ({ page, demoUrl }) => {
  await page.goto(demoUrl);
  const firstConversation = await createConversation(page);
  const heading = page.getByRole("heading", { level: 1 });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("First browser conversation");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-role="user"] .message-content')).toHaveText("First browser conversation");
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: First browser conversation");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();

  const secondConversation = await createConversation(page);
  expect(secondConversation).not.toBe(firstConversation);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Second browser conversation");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: Second browser conversation");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();

  await page.getByRole("button", { name: firstConversation, exact: true }).click();
  await expect(heading).toHaveText(firstConversation);
  await expect(page.locator('[data-role="user"]')).toContainText("First browser conversation");
  await expect(page.locator('[data-role="user"]')).not.toContainText("Second browser conversation");

  await page.reload();
  await expect(page.getByRole("button", { name: firstConversation, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: secondConversation, exact: true })).toBeVisible();
  await page.getByRole("button", { name: firstConversation, exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: First browser conversation");
  await page.getByRole("button", { name: secondConversation, exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: Second browser conversation");
  await expect(page.locator('[data-role="user"]')).not.toContainText("First browser conversation");
});

test("editing, regenerating and resetting use native conversations and active context", async ({ page, demoUrl }) => {
  await page.goto(demoUrl);
  const originalTitle = await createConversation(page);
  const heading = page.getByRole("heading", { level: 1 });
  const originalId = originalTitle.split(" ")[1];
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Original message for editing");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: Original message for editing");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit message", exact: true }).fill("Revised message for the fork");
  await page.getByRole("button", { name: "Save as fork", exact: true }).click();
  await expect(heading).not.toHaveText(originalTitle);
  await expect(page.locator('[data-role="user"] .message-content')).toHaveText("Revised message for the fork");
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: Revised message for the fork");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
  const editedTitle = await heading.innerText();
  const originalHistory = await (await page.request.get(`${demoUrl}/api/conversations/${originalId}/entries`)).json();
  expect(JSON.stringify(originalHistory)).toContain("Original message for editing");
  expect(JSON.stringify(originalHistory)).not.toContain("Revised message for the fork");

  const priorAnswerId = await page.locator('[data-role="assistant"]').last().getAttribute("data-entry-id");
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(heading).not.toHaveText(editedTitle);
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute("data-entry-id", /^\d+$/);
  await expect(page.locator('[data-role="assistant"]').last()).not.toHaveAttribute("data-entry-id", priorAnswerId!);
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: Revised message for the fork");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
  const regeneratedId = (await heading.innerText()).split(" ")[1];
  const regeneratedView = await (await page.request.get(`${demoUrl}/api/conversations/${regeneratedId}`)).json();
  expect(regeneratedView.conversation.parent.conversationId).toBe(Number(editedTitle.split(" ")[1]));

  await page.getByText("Conversation controls", { exact: true }).click();
  await page.getByLabel("Maximum tool rounds", { exact: true }).fill("3");
  await page.getByLabel("Thinking level").selectOption("low");
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Conversation configuration saved." })).toBeVisible();
  const configured = await (await page.request.get(`${demoUrl}/api/conversations/${regeneratedId}`)).json();
  expect(configured.docs["pi.agent"]).toMatchObject({ maxTurns: 3, thinkingLevel: "low" });

  await page.getByLabel("Reset handoff", { exact: true }).fill("Keep only this new handoff");
  await page.getByRole("button", { name: "Reset context", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Context reset requested" })).toBeVisible();
  const reset = await (await page.request.get(`${demoUrl}/api/conversations/${regeneratedId}/context`)).json();
  expect(reset.messages).toMatchObject([{ role: "user", content: "Keep only this new handoff" }]);
  expect(reset.messages).toHaveLength(1);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("You said: Keep only this new handoff");
});

test("image attachments and native file tools render in the full interface", async ({ page, demoUrl }) => {
  await page.goto(demoUrl);
  await createConversation(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files", exact: true }).click();
  await (await chooser).setFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1kAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByText("pixel.png", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Look at this image");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toContainText("Pi received 1 native image input block(s)");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();

  await page.getByRole("textbox", { name: "Message", exact: true }).fill("/files");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("Edited through Pi's native tool.");
  await expect(page.locator(".tool-result").filter({ hasText: "Edit file" })).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();

  await page.getByRole("textbox", { name: "Message", exact: true }).fill("/image");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("img", { name: "demo_image output 1", exact: true })).toBeVisible();
  const selectedId = (await page.getByRole("heading", { level: 1 }).innerText()).split(" ")[1];
  const history = await (await page.request.get(`${demoUrl}/api/conversations/${selectedId}/entries`)).json();
  expect(JSON.stringify(history.items)).toContain('"mimeType":"image/png"');
});

test("titles, archive state and feedback persist in the native conversation", async ({ page, demoUrl }) => {
  await page.goto(demoUrl);
  const originalTitle = await createConversation(page);
  const id = originalTitle.split(" ")[1];
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A response worth keeping");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: A response worth keeping");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.getByRole("button", { name: "Mark helpful", exact: true }).click();
  await expect.poll(async () => Object.values((await (await page.request.get(`${demoUrl}/api/conversations/${id}/metadata`)).json()).feedback)).toEqual(["positive"]);

  await page.getByLabel(`Actions for ${originalTitle}`, { exact: true }).click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation title", exact: true }).fill("Saved local conversation");
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved local conversation");
  await page.getByLabel("Actions for Saved local conversation", { exact: true }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved local conversation", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Archived conversations", exact: true }).click();
  await page.getByRole("button", { name: "Saved local conversation", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved local conversation");
  await expect(page.locator('[data-role="assistant"]')).toContainText("A response worth keeping");
  const archived = await (await page.request.get(`${demoUrl}/api/conversations/${id}/metadata`)).json();
  expect(archived).toMatchObject({ title: "Saved local conversation", archived: true });
  expect(Object.values(archived.feedback)).toEqual(["positive"]);

  await page.getByRole("button", { name: "Archived conversations", exact: true }).click();
  await page.getByLabel("Actions for Saved local conversation", { exact: true }).click();
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await page.getByRole("button", { name: "Active conversations", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved local conversation", exact: true })).toBeVisible();
  expect((await (await page.request.get(`${demoUrl}/api/conversations/${id}/metadata`)).json()).archived).toBe(false);
});

test("a pending human interaction survives reload and the response completes its native tool", async ({ page, demoUrl }) => {
  await page.goto(demoUrl);
  const title = await createConversation(page);
  const id = title.split(" ")[1];
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("/approval");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pi needs your input", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pi needs your input", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Response", exact: true }).fill("Proceed with the local demonstration");
  await page.getByRole("button", { name: "Send response", exact: true }).click();
  await expect(page.locator(".human-answer")).toContainText("Proceed with the local demonstration");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
  const history = await (await page.request.get(`${demoUrl}/api/conversations/${id}/entries`)).json();
  const results = history.items.flatMap((entry: { model?: Array<{ role: string; toolName?: string; content?: unknown }> }) => entry.model ?? []).filter((message: { role: string; toolName?: string }) => message.role === "toolResult" && message.toolName === "request_human_input");
  expect(JSON.stringify(results)).toContain("Proceed with the local demonstration");
});

test("forking from an edited user message retains the revision in native context", async ({ page, demoUrl }) => {
  await page.goto(demoUrl);
  const originalTitle = await createConversation(page);
  const originalId = originalTitle.split(" ")[1];
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Original prompt before revision");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: Original prompt before revision");
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
  const originalHistory = await (await page.request.get(`${demoUrl}/api/conversations/${originalId}/entries`)).json();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit message", exact: true }).fill("Revised prompt retained in later forks");
  await page.getByRole("button", { name: "Save as fork", exact: true }).click();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).not.toHaveText(originalTitle);
  await expect(page.locator('[data-role="assistant"]')).toContainText("You said: Revised prompt retained in later forks");
  await expect(page.locator('[data-role="assistant"]')).toHaveAttribute("data-entry-id", /^\d+$/);
  await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
  const editedTitle = await heading.innerText();
  const editedId = editedTitle.split(" ")[1];
  const editedHistory: { items: EntryRecord[] } = await (await page.request.get(`${demoUrl}/api/conversations/${editedId}/entries`)).json();
  const edit = editedHistory.items.find((entry) => entry.edits?.some((change) => change.action === "replace"))!;
  expect(edit).toBeDefined();

  await page.locator('[data-role="user"]').getByRole("button", { name: "Fork from here", exact: true }).click();
  await expect(heading).not.toHaveText(editedTitle);
  const forkId = (await heading.innerText()).split(" ")[1];
  const fork = await (await page.request.get(`${demoUrl}/api/conversations/${forkId}`)).json();
  expect(fork.conversation.parent).toEqual({ conversationId: Number(editedId), at: edit.id });
  const context = await (await page.request.get(`${demoUrl}/api/conversations/${forkId}/context`)).json();
  expect(JSON.stringify(context.messages)).toContain("Revised prompt retained in later forks");
  expect(JSON.stringify(context.messages)).not.toContain("Original prompt before revision");
  expect(await (await page.request.get(`${demoUrl}/api/conversations/${editedId}/entries`)).json()).toEqual(editedHistory);
  expect(await (await page.request.get(`${demoUrl}/api/conversations/${originalId}/entries`)).json()).toEqual(originalHistory);
});

test("loading the model catalog preserves the selected native model when saving another setting", async ({ page, demoUrl }) => {
  const created = await page.request.post(`${demoUrl}/api/conversations`, { data: { ownership: { kind: "ownerless" } } });
  expect(created.status()).toBe(201);
  const conversation = await created.json();
  let releaseModels!: () => void;
  let requestedModels!: () => void;
  const heldModels = new Promise<void>((resolve) => { releaseModels = resolve; });
  const modelsRequested = new Promise<void>((resolve) => { requestedModels = resolve; });
  await page.route("**/api/models", async (route) => {
    requestedModels();
    await heldModels;
    await route.continue();
  });

  try {
    await page.goto(`${demoUrl}/?conversation=${conversation.id}`);
    await modelsRequested;
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Conversation ${conversation.id}`);
    await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
    await page.getByText("Conversation controls", { exact: true }).click();
    const model = page.locator('select[name="model"]');
    await expect(model).toHaveValue('["faux","demo"]');

    releaseModels();
    await expect(model.locator("option")).toContainText(["No model", "Deterministic demo · faux/demo"]);
    await expect(model).toHaveValue('["faux","demo"]');
    await page.getByLabel("Maximum tool rounds", { exact: true }).fill("7");
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Conversation configuration saved." })).toBeVisible();
    const configured = await (await page.request.get(`${demoUrl}/api/conversations/${conversation.id}`)).json();
    expect(configured.docs["pi.agent"]).toMatchObject({ model: { provider: "faux", modelId: "demo" }, maxTurns: 7 });
  } finally {
    releaseModels();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("independent browsers converge after a streaming connection goes offline and returns", async ({ page, context, browser, streamingDemoUrl }) => {
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  const session = await context.newCDPSession(page);
  try {
    const created = await page.request.post(`${streamingDemoUrl}/api/conversations`, { data: { ownership: { kind: "ownerless" } } });
    expect(created.status()).toBe(201);
    const conversation = await created.json();
    const url = `${streamingDemoUrl}/?conversation=${conversation.id}`;
    await Promise.all([page.goto(url), otherPage.goto(url)]);
    await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
    await expect(otherPage.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();

    await page.getByRole("textbox", { name: "Message", exact: true }).fill("/long shared streaming conversation");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const firstOutput = page.locator('[data-role="assistant"] .message-content').last();
    const otherOutput = otherPage.locator('[data-role="assistant"] .message-content').last();
    await expect(firstOutput).toContainText("Native history keeps this paragraph");
    await expect(otherOutput).toContainText("Native history keeps this paragraph");
    expect(await firstOutput.innerText()).not.toContain("Try /tool");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
    await context.setOffline(true);
    // Cut the existing SSE too, so this exercises recovery rather than uninterrupted delivery.
    await session.send("Page.stopLoading");
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);

    await expect(otherOutput).toContainText("Try /tool");
    await expect(otherPage.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
    const committedText = await otherOutput.innerText();
    const committedId = await otherPage.locator('[data-role="assistant"]').getAttribute("data-entry-id");
    expect(committedId).toMatch(/^\d+$/);
    expect(await firstOutput.innerText()).not.toContain("Try /tool");
    await expect(page.locator(`[data-role="assistant"][data-entry-id="${committedId}"]`)).toHaveCount(0);
    await context.setOffline(false);
    await expect.poll(() => firstOutput.innerText()).toBe(committedText);
    await expect(page.locator('[data-role="assistant"]')).toHaveAttribute("data-entry-id", committedId!);
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(1);
    await expect(otherPage.locator('[data-role="assistant"]')).toHaveCount(1);

    await otherPage.getByRole("textbox", { name: "Message", exact: true }).fill("Message from the second browser");
    await otherPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator('[data-role="assistant"] .message-content').last()).toContainText("You said: Message from the second browser");
    await expect(otherPage.locator('[data-role="assistant"] .message-content').last()).toContainText("You said: Message from the second browser");
    await expect(page.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
    await expect(otherPage.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
    const history: { items: EntryRecord[] } = await (await page.request.get(`${streamingDemoUrl}/api/conversations/${conversation.id}/entries?order=ascending`)).json();
    const nativeIds = history.items.filter((entry) => entry.kind === "pi.assistant").map((entry) => String(entry.id));
    expect(nativeIds).toHaveLength(2);
    for (const observer of [page, otherPage]) {
      await expect(observer.locator('[data-role="assistant"]')).toHaveCount(2);
      await expect(observer.locator('[data-role="user"]')).toHaveCount(2);
      expect(await observer.locator('[data-role="assistant"]').evaluateAll((elements) => elements.map((element) => element.getAttribute("data-entry-id")))).toEqual(nativeIds);
    }
  } finally {
    await context.setOffline(false);
    await session.detach();
    await otherContext.close();
  }
});
