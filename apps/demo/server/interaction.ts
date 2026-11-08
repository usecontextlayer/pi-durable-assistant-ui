import type { Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  defineTool,
  type Harness,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

export const HUMAN_INPUT_TOOL_NAME = "request_human_input";

type HumanInputState = {
  prompt: string;
  response: string | null;
};

export type HumanInputDetails = {
  type: "human-input";
  taskId: TaskId;
  prompt: string;
  status: "pending" | "answered";
  response?: string;
};

export const HumanInputDoc = defineDoc<HumanInputState>({
  kind: "demo.human-input",
  version: 1,
  scope: "task",
  initial: () => ({ prompt: "", response: null }),
  checkpointWhen: () => false,
});

function details(taskId: TaskId, state: Readonly<HumanInputState>): HumanInputDetails {
  return {
    type: "human-input",
    taskId,
    prompt: state.prompt,
    status: state.response === null ? "pending" : "answered",
    ...(state.response === null ? {} : { response: state.response }),
  };
}

async function waitForResponse(api: ToolExecutionApi<HumanInputDetails>, context: Context): Promise<string> {
  const watch = await api.watchDoc(HumanInputDoc, api.taskId, context);
  if (!watch) throw new Error("The human input request is no longer available.");

  try {
    return await new Promise<string>((resolve, reject) => {
      const accept = (state: Readonly<HumanInputState>) => {
        if (state.response !== null) resolve(state.response);
      };
      accept(watch.value);
      watch.start(async (call) => {
        if (call.kind === "value") accept(call.value);
      });
      void watch.closed.then((end) => reject(new Error(`Human input observation ended: ${end.kind}`)));
    });
  } finally {
    await watch.stop();
  }
}

export const humanInputExtension = defineExtension({
  name: "demo-human-input",
  tools: [defineTool({
    name: HUMAN_INPUT_TOOL_NAME,
    description: "Ask the person for a decision or text response before continuing.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    } as const,
    replay: "safe",
    async execute(args, api, context) {
      const { prompt } = args as { prompt: string };
      const state = await api.commit(async (tx) => {
        const state = await tx.doc(HumanInputDoc, api.taskId);
        state.prompt = prompt;
        return { ...state };
      }, context);
      await api.details(details(api.taskId, state), context);

      // The native document survives a restart; this observation only waits for its current value.
      const response = await waitForResponse(api, context);
      return {
        output: [{ type: "text" as const, text: response }],
        details: details(api.taskId, { prompt, response }),
      };
    },
  })],
});

export async function respondToHumanInput(
  harness: Harness,
  taskId: TaskId,
  response: string,
  context: Context,
): Promise<HumanInputDetails> {
  if (!await harness.snapshot(HumanInputDoc, taskId, context)) {
    throw new Error("The human input request is no longer available.");
  }
  return harness.commit(async (tx) => {
    const task = await tx.task(taskId);
    if (!task || task.state.status === "terminal") {
      throw new Error("The human input request is no longer available.");
    }
    const state = await tx.doc(HumanInputDoc, taskId);
    if (state.response === null) state.response = response;
    return details(taskId, state);
  }, context);
}
