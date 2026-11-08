import { getSystemMessageText, type AssistantMessage, type Message, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";

function messageText(message: Extract<Message, { role: "user" | "toolResult" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export const DEMO_SCENARIOS = [
  { command: "/tool", description: "Run a real native bash tool." },
  { command: "/slow", description: "Run a slow tool to exercise queueing, steering, and cancellation." },
  { command: "/parallel", description: "Run two native tools in one model turn." },
  { command: "/files", description: "Write, read, edit, and read a working file through native tools." },
  { command: "/tool-error", description: "Render a failed native tool call." },
  { command: "/nested", description: "Run a tool with two native nested calls." },
  { command: "/progress", description: "Stream tool output and structured progress details." },
  { command: "/image", description: "Return a native PNG tool-output block." },
  { command: "/subagent", description: "Delegate to a real foreground child conversation." },
  { command: "/handoff", description: "Start a new active context through a native tool handoff." },
  { command: "/approval", description: "Wait for a person through durable native human input." },
  { command: "/background", description: "Start a real background child and receive its result later." },
  { command: "/limit", description: "Run multiple tool turns to exercise maxTurns and continuation." },
  { command: "/read <path>", description: "Read an uploaded text file or image through the native read tool." },
  { command: "/instructions", description: "Show which registered instruction sections reached this request." },
  { command: "/long", description: "Stream a longer response." },
  { command: "/error", description: "Show a deterministic provider error." },
] as const;

function toolTurn(name: string, args: ToolCall["arguments"], thinking: string) {
  return fauxAssistantMessage([fauxThinking(thinking), fauxToolCall(name, args)], { stopReason: "toolUse" });
}

export function demoResponse(context: TranscriptContext): AssistantMessage {
  const userIndex = context.messages.findLastIndex((message) => message.role === "user");
  const lastUser = context.messages[userIndex];
  const results = context.messages.slice(userIndex + 1).filter((message) => message.role === "toolResult");
  const input = lastUser?.role === "user" ? messageText(lastUser) : "Continue the conversation";

  if (input.startsWith("/instructions")) {
    const sections = context.messages.filter((message) => message.role === "system").map(getSystemMessageText);
    return fauxAssistantMessage(sections.join("\n\n"));
  }

  if (input.startsWith("/error")) {
    return fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "This is the deterministic provider error scenario.",
    });
  }

  if (input.startsWith("/files")) {
    if (results.length === 0) return toolTurn("write", { path: "demo-note.txt", content: "Hello from Pi.\n" }, "I will create a working file through Pi's native write tool.");
    if (results.length === 1) return toolTurn("read", { path: "demo-note.txt" }, "I will inspect the actual file.");
    if (results.length === 2) return toolTurn("edit", { path: "demo-note.txt", edits: [{ oldText: "Hello from Pi.", newText: "Edited through Pi's native tool." }] }, "I will apply a targeted edit.");
    if (results.length === 3) return toolTurn("read", { path: "demo-note.txt" }, "I will verify the edited file.");
  }

  if (input.startsWith("/limit") && results.length < 3) {
    return toolTurn("bash", { command: `printf 'Native tool turn ${results.length + 1}\\n'` }, "This scenario intentionally needs several model turns.");
  }

  if (results.length === 0 && input.startsWith("/slow")) {
    return toolTurn("bash", { command: "printf 'Starting slow native tool\\n'; sleep 2; printf 'Slow tool finished\\n'" }, "This native command leaves time to queue, steer, or cancel.");
  }

  if (results.length === 0 && input.startsWith("/parallel")) {
    return fauxAssistantMessage([
      fauxThinking("These independent native commands can execute in parallel."),
      fauxToolCall("bash", { command: "sleep 0.2; printf 'First parallel result\\n'" }),
      fauxToolCall("bash", { command: "sleep 0.2; printf 'Second parallel result\\n'" }),
    ], { stopReason: "toolUse" });
  }

  if (results.length === 0 && input.startsWith("/read ")) {
    return toolTurn("read", { path: input.slice(6).trim() }, "I will read the uploaded file through the native environment.");
  }

  if (results.length === 0 && input.startsWith("/tool-error")) {
    return toolTurn("bash", { command: "printf 'Intentional tool failure\\n' >&2; exit 7" }, "This scenario demonstrates an actual failed native command.");
  }

  if (results.length === 0 && input.startsWith("/nested")) {
    return toolTurn("demo_nested", {}, "I will invoke a native tool that owns two nested calls.");
  }
  if (results.length === 0 && input.startsWith("/progress")) {
    return toolTurn("demo_progress", {}, "The native tool will publish progress while it runs.");
  }
  if (results.length === 0 && input.startsWith("/image")) {
    return toolTurn("demo_image", {}, "I will request a native image tool result.");
  }
  if (results.length === 0 && input.startsWith("/subagent")) {
    return toolTurn("demo_subagent", { task: "Explain briefly what a native Pi child conversation is." }, "I will delegate this task to a native child conversation.");
  }
  if (results.length === 0 && input.startsWith("/handoff")) {
    return toolTurn("demo_handoff", {}, "I will perform a native context handoff.");
  }
  if (results.length === 0 && input.startsWith("/approval")) {
    return toolTurn("request_human_input", { prompt: "What should the demo agent do next? Your response is stored durably before the tool continues." }, "I will wait for a real human response.");
  }
  if (results.length === 0 && input.startsWith("/background")) {
    return toolTurn("demo_background", { prompt: "/slow" }, "I will start a native background child and continue here.");
  }

  if (results.length === 0 && input.startsWith("/tool")) {
    return fauxAssistantMessage(
      [
        fauxThinking("I will run a real local command through Pi's native bash tool."),
        fauxToolCall("bash", { command: "printf 'Hello from the native Pi execution environment\\n'" }),
      ],
      { stopReason: "toolUse" },
    );
  }

  if (results.length > 0) {
    return fauxAssistantMessage([
      fauxThinking("The tools completed. I can now use their actual results."),
      fauxText(results.map((result) => `### ${result.toolName}${result.isError ? " (failed)" : ""}\n\n\`\`\`text\n${messageText(result)}\n\`\`\``).join("\n\n")),
    ]);
  }

  const imageCount = lastUser?.role === "user" && Array.isArray(lastUser.content)
    ? lastUser.content.filter((part) => part.type === "image").length
    : 0;
  const explanation = input.startsWith("/long")
    ? Array.from({ length: 12 }, (_, index) => `${index + 1}. Native history keeps this paragraph after reload or reconnect.`).join("\n\n")
    : "This answer is streamed by Pi's deterministic provider and committed to the same native transcript used by real models.";

  return fauxAssistantMessage([
    fauxThinking("I can respond using the conversation's current native context."),
    fauxText(`You said: **${input}**${imageCount ? `\n\nPi received ${imageCount} native image input block(s). This deterministic provider does not perform image recognition.` : ""}\n\n${explanation}\n\nTry \`/tool\`, \`/files\`, \`/parallel\`, \`/long\`, or \`/error\` to exercise another native path.`),
  ]);
}

export function createDemoProvider(options: {
  tokensPerSecond?: number;
  response?: FauxResponseFactory;
} = {}): { provider: Provider; faux: FauxProviderHandle } {
  const faux = fauxProvider({
    api: "demo-faux",
    provider: "faux",
    models: [{ id: "demo", name: "Deterministic demo", reasoning: true, input: ["text", "image"] }],
    tokensPerSecond: options.tokensPerSecond ?? 120,
  });
  const response = options.response ?? demoResponse;

  // Queue one response immediately before its corresponding native stream call.
  const provider: Provider = {
    ...faux.provider,
    stream(model, context, streamOptions) {
      faux.appendResponses([response]);
      return faux.provider.stream(model, context, streamOptions);
    },
    streamSimple(model, context, streamOptions) {
      faux.appendResponses([response]);
      return faux.provider.streamSimple(model, context, streamOptions);
    },
  };
  return { provider, faux };
}
