import {
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type EntryRecord,
} from "@earendil-works/pi-durable";

type BackgroundInput = { prompt: string };
type BackgroundState = { phase: "deliver" } | { phase: "report"; conversationId: ConversationId; report: string };

function answerText(entry: EntryRecord | undefined) {
  return entry?.model?.flatMap((message) => message.role === "assistant"
    ? message.content.filter((part) => part.type === "text").map((part) => part.text)
    : []).join("\n") ?? "The background conversation finished.";
}

export const DemoBackgroundWork = defineTask<BackgroundInput, BackgroundState, null>({
  name: "demo.background-work",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    async deliver(task, runtime, context) {
      let childId: ConversationId | undefined;
      await runtime.commit(async (tx) => {
        childId = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0]?.id;
      }, context);
      if (childId === undefined) throw new Error("The background task's child conversation is missing.");
      const child = (await runtime.conversation(childId, context))!;
      const submission = await child.submit({ type: "input", content: task.input.prompt, requestId: `background:${task.id}` }, context);
      const outcome = await submission.wait(context);
      const conversationId = childId;
      await runtime.commit(async (tx) => ({
        status: "running",
        checkpoint: {
          phase: "report",
          conversationId,
          report: outcome.status === "done" && outcome.type === "input"
            ? answerText(await tx.entry(outcome.answer))
            : `Background conversation ended with ${outcome.status}.`,
        },
      }), context);
    },
    async report(task, runtime, context) {
      const parent = (await runtime.conversation(runtime.conversationId, context))!;
      await parent.submit({
        type: "input",
        content: `[Background conversation ${task.state.checkpoint.conversationId} completed]\n${task.state.checkpoint.report}`,
        whenBusy: "followUp",
        requestId: `background-report:${task.id}`,
        entry: { kind: "demo.background-report", data: { taskId: task.id, conversationId: task.state.checkpoint.conversationId } },
      }, context);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export const BackgroundTools = defineExtension({
  name: "demo-background",
  tasks: [DemoBackgroundWork],
  tools: [defineTool({
    name: "demo_background",
    description: "Start a real Pi background task and child conversation. Its result returns as a follow-up while the parent can answer immediately.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    } as const,
    // The spawn commits before the tool returns; an interrupted call must not spawn another child.
    replay: "unsafe",
    async execute(args, api, context) {
      const { prompt } = args as BackgroundInput;
      const started = await api.commit(async (tx) => {
        const taskId = await tx.createTask(DemoBackgroundWork, { prompt }, {
          ownership: { kind: "conversation" },
          background: true,
        });
        const child = await tx.createConversation({ ownership: { kind: "task", taskId } });
        return { taskId, conversationId: child.id, background: true };
      }, context);
      await api.details(started, context);
      return {
        output: [{ type: "text", text: `Background conversation ${started.conversationId} is running. You can continue in this conversation.` }],
        details: started,
      };
    },
  })],
});
