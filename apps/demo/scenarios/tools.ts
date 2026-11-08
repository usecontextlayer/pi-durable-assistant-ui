import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { setTimeout } from "node:timers/promises";

const noArguments = { type: "object", properties: {}, additionalProperties: false } as const;
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1kAAAAASUVORK5CYII=";

export const DemoTools = defineExtension({
  name: "demo-tools",
  tools: [
    defineTool({
      name: "demo_subagent",
      description: "Delegate a task to a real foreground Pi child conversation and return its answer.",
      parameters: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: false,
      } as const,
      replay: "safe",
      async execute(args, api, context) {
        const { task } = args as { task: string };
        const childId = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing) return existing.id;
          return (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id;
        }, context);
        await api.details({ conversationId: childId }, context);
        const child = (await api.conversation(childId, context))!;
        const submission = await child.submit({ type: "input", content: task, requestId: `child:${api.taskId}` }, context);
        const result = await submission.wait(context);
        if (result.status !== "done" || result.type !== "input") {
          return { isError: true, output: [{ type: "text", text: `Child conversation did not produce an input answer (${result.status}).` }] };
        }
        const answer = await api.commit((tx) => tx.entry(result.answer), context);
        const text = answer?.model?.flatMap((message) => message.role === "assistant"
          ? message.content.filter((part) => part.type === "text").map((part) => part.text)
          : []).join("\n") ?? "Child completed.";
        return { output: [{ type: "text", text }], details: { conversationId: childId } };
      },
    }),
    defineTool({
      name: "demo_handoff",
      description: "Use Pi's native tool-directed handoff to begin a new active context while preserving history.",
      parameters: noArguments,
      async execute() {
        return {
          output: [{ type: "text", text: "The original context is retained in history." }],
          control: { handoff: "The previous task completed a native handoff. Briefly acknowledge the new context." },
        };
      },
    }),
    defineTool({
      name: "demo_nested",
      description: "Demonstrate two native nested tool calls with their own live status and results.",
      parameters: noArguments,
      replay: "safe",
      async execute(_args, api, context) {
        const results = await Promise.all([
          api.executeTool("bash", { command: "printf 'First nested call\\n'" }, context, { key: "first" }),
          api.executeTool("bash", { command: "printf 'Second nested call\\n'" }, context, { key: "second" }),
        ]);
        return {
          output: results.map((result) => ({
            type: "text" as const,
            text: typeof result.structuredOutput === "string" ? result.structuredOutput : JSON.stringify(result.structuredOutput ?? result.diagnostics),
          })),
          isError: results.some((result) => result.isError),
          details: { nestedCalls: results.length },
        };
      },
    }),
    defineTool({
      name: "demo_progress",
      description: "Report real streamed tool output and structured progress during a short local operation.",
      parameters: noArguments,
      async execute(_args, api, context) {
        for (let completed = 1; completed <= 5; completed += 1) {
          await setTimeout(150, undefined, { signal: context.abortSignal });
          api.output(`Completed step ${completed} of 5.\n`);
          await api.details({ completed, total: 5 }, context);
        }
        return { details: { completed: 5, total: 5 } };
      },
    }),
    defineTool({
      name: "demo_image",
      description: "Return a deterministic PNG image block to exercise native tool-image rendering.",
      parameters: noArguments,
      replay: "safe",
      async execute() {
        return {
          output: [
            { type: "text" as const, text: "A deterministic one-pixel PNG fixture." },
            { type: "image" as const, data: image, mimeType: "image/png" },
          ],
          details: { image: `data:image/png;base64,${image}`, label: "Native tool image" },
        };
      },
    }),
  ],
});
