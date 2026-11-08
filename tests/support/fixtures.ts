import { projectConversation, isForegroundRunning } from "../../packages/adapter/src/projection.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base } from "vitest";
import type { PiDurableClient } from "../../packages/adapter/src/client.js";
import type { SubmissionRecord } from "../../packages/adapter/src/index.js";

export const test = base.extend<{ dataDirectory: string }>({
  dataDirectory: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-ui-test-"));
    try {
      await use(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

export async function settled(client: PiDurableClient, submission: SubmissionRecord) {
  let result = submission;
  await expect.poll(async () => {
    result = await client.getSubmission(submission.id);
    return result.status === "done" || result.status === "unanswered";
  }, { timeout: 10_000 }).toBe(true);
  return result;
}

export async function answered(client: PiDurableClient, submission: SubmissionRecord) {
  const result = await settled(client, submission);
  if (result.status === "unanswered") throw new Error(`Submission ${result.id} was unanswered: ${result.reason}`);
  if (result.type !== "input" || result.status !== "done") throw new Error("Expected an answered input submission");
  return result;
}

export function observedMessages(conversation: import("../../packages/adapter/src/conversation.js").PiDurableConversation) {
  const state = conversation.getSnapshot();
  return state.view ? projectConversation(state.view, state.metadata) : [];
}

export function isRunning(conversation: import("../../packages/adapter/src/conversation.js").PiDurableConversation) {
  const view = conversation.getSnapshot().view;
  return view ? isForegroundRunning(view) : false;
}
