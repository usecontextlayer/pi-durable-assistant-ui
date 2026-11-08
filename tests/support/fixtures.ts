import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base } from "vitest";
import type { PiClient } from "../../packages/adapter/src/client.js";
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

export async function settled(client: PiClient, submission: SubmissionRecord) {
  let result = submission;
  await expect.poll(async () => {
    result = await client.getSubmission(submission.id);
    return result.status === "done" || result.status === "unanswered";
  }, { timeout: 10_000 }).toBe(true);
  return result;
}

export async function answered(client: PiClient, submission: SubmissionRecord) {
  const result = await settled(client, submission);
  if (result.status === "unanswered") throw new Error(`Submission ${result.id} was unanswered: ${result.reason}`);
  if (result.type !== "input" || result.status !== "done") throw new Error("Expected an answered input submission");
  return result;
}
