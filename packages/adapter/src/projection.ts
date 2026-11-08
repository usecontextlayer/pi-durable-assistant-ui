import type { PiDurableHumanInputDetails } from "./client.js";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { CompactionEntry, ResetEntry, SystemEntry } from "@earendil-works/pi-durable";
import type { ContextEdit, EntryId, EntryRecord, InboxState, LiveState, TranscriptView, UserInput } from "@earendil-works/pi-durable";
import type { ConversationMetadata } from "./metadata.js";

type ContentPart = Exclude<ThreadMessageLike["content"], string>[number];
type ToolPart = Extract<ContentPart, { type: "tool-call" }>;
type MutableMessage = Omit<ThreadMessageLike, "content" | "status"> & { content: ContentPart[]; status?: ThreadMessageLike["status"] };

export function conversationLiveState(view: Pick<TranscriptView, "docs">): LiveState {
  return (view.docs["pi.live"] ?? {}) as LiveState;
}

export function conversationInbox(view: Pick<TranscriptView, "docs">): InboxState {
  return (view.docs["pi.inbox"] ?? { items: [] }) as InboxState;
}

export function entryIdFromMessageId(id: string): EntryId {
  const match = /^entry:(\d+):(?:\d+|notice)$/.exec(id);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Message ${id} is not a committed Pi entry`);
  return Number(match[1]) as EntryId;
}

/** Foreground generation is distinct from a run's after-run/background work. */
export function isForegroundRunning(view: Pick<TranscriptView, "docs">): boolean {
  const live = conversationLiveState(view);
  return live.run !== undefined && live.run.afterRun === undefined;
}

function userContent(content: UserMessage["content"]): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image", image: `data:${part.mimeType};base64,${part.data}` });
}

function assistantContent(message: AssistantMessage, calls: Map<string, ToolPart>): ContentPart[] {
  return message.content.map((part): ContentPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "thinking") return { type: "reasoning", text: part.thinking };
    const tool: ToolPart = { type: "tool-call", toolCallId: part.id, toolName: part.name, args: part.arguments };
    calls.set(part.id, tool);
    return tool;
  });
}

function applyToolResult(tool: ToolPart, message: ToolResultMessage): void {
  Object.assign(tool, {
    artifact: message.details,
    result: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    isError: message.isError,
    isPreliminary: false,
    approval: humanInputApproval(message.details),
    modelContent: message.content.map((part) => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "file", mediaType: part.mimeType, data: part.data }),
  });
}

function messageStatus(message: AssistantMessage): ThreadMessageLike["status"] {
  if (message.stopReason === "error") return { type: "incomplete", reason: "error", error: message.errorMessage ?? "Model request failed" };
  if (message.stopReason === "aborted") return { type: "incomplete", reason: "cancelled" };
  if (message.stopReason === "length") return { type: "incomplete", reason: "length" };
  return { type: "complete", reason: "stop" };
}

export function projectConversationHistory(items: TranscriptView["items"], conversationMetadata?: ConversationMetadata) {
  const messages: MutableMessage[] = [];
  const calls = new Map<string, ToolPart>();
  const edits = new Map<EntryId, { change: ContextEdit; by: EntryId }>();
  for (const item of items) {
    if (item.kind === "entry") {
      for (const change of item.entry.edits ?? []) edits.set(change.target, { change, by: item.entry.id });
    }
  }

  function append(entry: EntryRecord, message: Message, index: number) {
    const metadata = { custom: { conversationId: entry.conversationId, entryId: entry.id, entryKind: entry.kind, editEntryId: edits.get(entry.id)?.by } };
    const id = `entry:${entry.id}:${index}`;
    if (message.role === "user") {
      messages.push({ id, role: "user", content: userContent(message.content), createdAt: new Date(message.timestamp), metadata });
    } else if (message.role === "assistant") {
      const feedback = conversationMetadata?.feedback[entry.id];
      messages.push({ id, role: "assistant", content: assistantContent(message, calls), status: messageStatus(message), createdAt: new Date(message.timestamp), metadata: { ...metadata, ...(feedback ? { submittedFeedback: { type: feedback } } : {}) } });
    } else if (message.role === "toolResult") {
      let tool = calls.get(message.toolCallId);
      if (!tool) {
        tool = { type: "tool-call", toolCallId: message.toolCallId, toolName: message.toolName, args: {} };
        calls.set(message.toolCallId, tool);
        messages.push({ id, role: "assistant", content: [tool], metadata });
      }
      applyToolResult(tool, message);
    }
  }

  for (const item of items) {
    if (item.kind !== "entry") continue;
    const entry = item.entry;
    if (SystemEntry.is(entry)) continue;
    if (CompactionEntry.is(entry) || ResetEntry.is(entry)) {
      const text = (entry.model ?? []).flatMap((message) => message.role === "user"
        ? typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
        : []).join("\n");
      messages.push({
        id: `entry:${entry.id}:notice`,
        role: "assistant",
        content: [{ type: "data", name: "pi-context", data: { kind: entry.kind, data: entry.data, text } }],
        metadata: { custom: { conversationId: entry.conversationId, entryId: entry.id, entryKind: entry.kind, entryData: entry.data } },
      });
      continue;
    }
    const edit = edits.get(entry.id)?.change;
    const model = edit ? (edit.action === "replace" ? edit.messages : []) : (entry.model ?? []);
    for (const [index, message] of model.entries()) append(entry, message, index);
  }

  return { messages, calls };
}

export function projectConversationLive(history: ReturnType<typeof projectConversationHistory>, live: LiveState, conversationId: TranscriptView["conversation"]["id"]): readonly ThreadMessageLike[] {
  const messages = [...history.messages];
  const calls = new Map(history.calls);
  if (live.generation?.message) {
    const message = live.generation.message as AssistantMessage;
    messages.push({
      id: `generation:${live.run?.taskId ?? conversationId}`,
      role: "assistant",
      content: assistantContent(message, calls),
      status: { type: "running" },
      createdAt: new Date(message.timestamp),
      metadata: { isOptimistic: true, custom: { conversationId, taskId: live.run?.taskId } },
    });
  }
  for (const slot of live.tools ?? []) {
    let tool = calls.get(slot.callId);
    if (!tool) {
      tool = { type: "tool-call", toolCallId: slot.callId, toolName: slot.name, args: {} };
      calls.set(slot.callId, tool);
      messages.push({ id: `tool:${slot.callId}`, role: "assistant", content: [tool], status: { type: "running" }, metadata: { isOptimistic: true } });
    }
    if (slot.status !== "done") {
      const ownerIndex = messages.findIndex((message) => message.content.includes(tool));
      const owner = messages[ownerIndex]!;
      const updated = { ...tool, result: slot.output, artifact: slot.details, isPreliminary: true, approval: humanInputApproval(slot.details) };
      calls.set(slot.callId, updated);
      messages[ownerIndex] = { ...owner, content: owner.content.map((part) => part === tool ? updated : part), status: { type: "running" } };
    }
  }
  const failure = live.runFailure;
  const lastStatus = messages.at(-1)?.status;
  if (failure && failure.reason !== "aborted" && failure.reason !== "reset" && failure.reason !== "nothing_to_answer" && !(lastStatus?.type === "incomplete" && lastStatus.reason === "error")) {
    messages.push({ id: `failure:${failure.taskId}`, role: "assistant", content: [], status: { type: "incomplete", reason: "error", error: failure.detail ?? failure.reason }, metadata: { isOptimistic: true, custom: { conversationId, taskId: failure.taskId } } });
  }
  return messages;
}

/** Pure projection of Pi history and current execution; Pi retains the durable originals. */
export function projectConversation(view: TranscriptView, metadata?: ConversationMetadata): readonly ThreadMessageLike[] {
  return projectConversationLive(projectConversationHistory(view.items, metadata), conversationLiveState(view), view.conversation.id);
}

function humanInputApproval(value: unknown): ToolPart["approval"] {
  if (value === null || typeof value !== "object") return undefined;
  const details = value as Partial<PiDurableHumanInputDetails>;
  if (details.type !== "human-input" || typeof details.taskId !== "number" || typeof details.prompt !== "string" || (details.status !== "pending" && details.status !== "answered")) return undefined;
  return { id: String(details.taskId), prompt: details.prompt, display: "text", ...(details.status === "answered" ? { approved: true, text: details.response } : {}) };
}

/** Convert only the user's new input; never send the rendered transcript back to Pi. */
export function toPiUserInput(message: AppendMessage): UserInput {
  const content: Exclude<UserInput, string>[number][] = [];
  const parts = [...message.content, ...(message.attachments ?? []).flatMap((attachment) => attachment.content)];
  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image);
      if (!match) throw new Error("Image input must be a base64 data URL");
      content.push({ type: "image", mimeType: match[1]!, data: match[2]! });
    } else throw new Error(`Unsupported Pi input part: ${part.type}`);
  }
  return content;
}
