import type { PiDurableHumanInputDetails } from "../packages/adapter/src/client.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, ToolResultEntry, type Conversation, type TaskId } from "@earendil-works/pi-durable";
import { expect, test as base } from "vitest";
import { openLocalPiHost, type LocalPiHost } from "../apps/demo/server/host.js";
import {
  HUMAN_INPUT_TOOL_NAME,
  HumanInputDoc,
  humanInputExtension,
  respondToHumanInput,
} from "../apps/demo/server/human-input.js";

const context = BACKGROUND_CONTEXT;
const response: FauxResponseFactory = (transcript) => transcript.messages.some((message) => message.role === "toolResult")
  ? fauxAssistantMessage("The native human input tool finished.")
  : fauxAssistantMessage(fauxToolCall(HUMAN_INPUT_TOOL_NAME, { prompt: "May I continue?" }), { stopReason: "toolUse" });

const test = base.extend<{ dataDirectory: string }>({
  dataDirectory: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-ui-human-input-"));
    try {
      await use(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function open(dataDirectory: string) {
  const host = await openLocalPiHost({ dataDirectory, response, tokensPerSecond: 10000 });
  host.registry.install(humanInputExtension);
  return host;
}

async function pending(host: LocalPiHost, conversation: Conversation): Promise<PiDurableHumanInputDetails> {
  let found: PiDurableHumanInputDetails | undefined;
  await expect.poll(async () => {
    const live = await host.harness.snapshot(LiveDoc, conversation.id, context);
    const slot = live?.tools?.find((tool) => tool.name === HUMAN_INPUT_TOOL_NAME);
    found = slot?.details as PiDurableHumanInputDetails | undefined;
    return found?.status;
  }).toBe("pending");
  return found!;
}

test("human input completes the original native tool and submission", async ({ dataDirectory }) => {
  const host = await open(dataDirectory);
  try {
    const conversation = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: host.defaultAgent }, context);
    const submission = await conversation.submit({ type: "input", content: "Ask for a decision." }, context);
    const request = await pending(host, conversation);
    const taskId = request.taskId as TaskId;
    expect(await host.harness.snapshot(HumanInputDoc, taskId, context)).toMatchObject({ response: null });
    expect(await submission.status(context)).toMatchObject({ status: "placed" });

    await respondToHumanInput(host.harness, taskId, "Approved", context);
    expect(await submission.wait(context)).toMatchObject({ id: submission.id, status: "done" });
    const history = await conversation.entries({}, 100, undefined, context);
    const results = history.items.filter((entry) => ToolResultEntry.is(entry));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      byTaskId: taskId,
      model: [{ role: "toolResult", content: [{ type: "text", text: "Approved" }], details: { status: "answered", response: "Approved" } }],
    });
  } finally {
    await host.close();
  }
});

test("a pending request survives host restart and accepts a response on its original task", async ({ dataDirectory }) => {
  const first = await open(dataDirectory);
  const { conversationId, submissionId, request } = await (async () => {
    try {
      const conversation = await first.harness.createConversation({ ownership: { kind: "ownerless" }, agent: first.defaultAgent }, context);
      const submission = await conversation.submit({ type: "input", content: "Wait for my response." }, context);
      return { conversationId: conversation.id, submissionId: submission.id, request: await pending(first, conversation) };
    } finally {
      await first.close();
    }
  })();

  const second = await open(dataDirectory);
  try {
    const reopened = await second.harness.conversation(conversationId, context);
    expect(reopened).toBeDefined();
    const resumed = await pending(second, reopened!);
    expect(resumed.taskId).toBe(request.taskId);
    expect(await second.harness.snapshot(HumanInputDoc, resumed.taskId as TaskId, context)).toMatchObject({ response: null });

    await respondToHumanInput(second.harness, resumed.taskId as TaskId, "My decision after restart", context);
    const original = await second.harness.submission(submissionId, context);
    expect(await original!.wait(context)).toMatchObject({ id: submissionId, status: "done" });
    const history = await reopened!.entries({}, 100, undefined, context);
    const results = history.items.filter((entry) => ToolResultEntry.is(entry));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ byTaskId: request.taskId, model: [{ content: [{ type: "text", text: "My decision after restart" }] }] });
  } finally {
    await second.close();
  }
});
