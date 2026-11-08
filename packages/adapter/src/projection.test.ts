import { describe, expect, it } from "vitest";
import type { AppendMessage } from "@assistant-ui/react";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, TranscriptView } from "@earendil-works/pi-durable";
import { isForegroundRunning, projectConversation, projectConversationHistory, projectConversationLive, toPiUserInput } from "./projection.js";
import type { ConversationMetadata } from "./metadata.js";

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, timestamp: 1000, stopReason,
    api: "openai-responses", provider: "test", model: "test",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function result(id: string, text: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError, timestamp: 1001 };
}

function entry(id: number, model: Message[], kind = "pi.assistant"): EntryRecord {
  return { id, conversationId: 1, kind, model } as unknown as EntryRecord;
}

function view(entries: EntryRecord[], live: LiveState = {}): TranscriptView {
  return {
    conversation: { id: 1 },
    items: entries.map((item) => ({ kind: "entry", entry: item })),
    docs: { "pi.live": live },
  } as unknown as TranscriptView;
}

describe("Pi conversation projection", () => {
  it("puts parallel tool results on the matching call, irrespective of completion order", () => {
    const projected = projectConversation(view([
      entry(10, [assistant([
        { type: "text", text: "Reading both files" },
        { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
        { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b" } },
      ], "toolUse")]),
      entry(11, [result("call-b", "B")], "pi.tool"),
      entry(12, [result("call-a", "A", true)], "pi.tool"),
    ]));
    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toEqual([
      { type: "text", text: "Reading both files" },
      expect.objectContaining({ type: "tool-call", toolCallId: "call-a", result: "A", isError: true }),
      expect.objectContaining({ type: "tool-call", toolCallId: "call-b", result: "B", isError: false }),
    ]);
  });

  it("keeps committed row identities when older history is prepended", () => {
    const newest = entry(20, [assistant([{ type: "text", text: "Latest answer" }])]);
    const before = projectConversation(view([newest]));
    const after = projectConversation(view([
      entry(2, [{ role: "user", content: "Earlier question", timestamp: 2 }]),
      newest,
    ]));
    expect(before[0]?.id).toBe("entry:20:0");
    expect(after[1]?.id).toBe(before[0]?.id);
    expect(after[1]?.content).toEqual(before[0]?.content);
  });

  it("preserves the position of a tool result whose call is outside the loaded window", () => {
    const projected = projectConversation(view([
      entry(11, [result("earlier-call", "Read result")], "pi.tool"),
      entry(12, [assistant([{ type: "text", text: "Answer after the read" }])]),
    ]));
    expect(projected.map((message) => message.id)).toEqual(["entry:11:0", "entry:12:0"]);
    expect(projected[0]?.content).toEqual([expect.objectContaining({ toolCallId: "earlier-call", result: "Read result" })]);
  });

  it("projects partial text/reasoning and streaming tool output from native live state", () => {
    const projected = projectConversation(view([
      entry(10, [assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], "toolUse")]),
    ], {
      run: { taskId: 7, inputs: [1], turns: 0 },
      generation: { attempt: 1, message: assistant([{ type: "thinking", thinking: "Considering" }, { type: "text", text: "Partial" }]) },
      tools: [{ callId: "read-1", name: "read", status: "running", output: "Reading..." }],
    } as unknown as LiveState));
    expect(projected[0]?.content).toEqual([expect.objectContaining({ result: "Reading...", isPreliminary: true })]);
    expect(projected[0]?.status).toEqual({ type: "running" });
    expect(projected[1]).toMatchObject({ id: "generation:7", status: { type: "running" } });
    expect(projected[1]?.content).toEqual([{ type: "reasoning", text: "Considering" }, { type: "text", text: "Partial" }]);
  });

  it("separates foreground generation from after-run work", () => {
    expect(isForegroundRunning(view([], { run: { taskId: 7, inputs: [1], turns: 0 } } as unknown as LiveState))).toBe(true);
    expect(isForegroundRunning(view([], { run: { taskId: 7, inputs: [], turns: 0, afterRun: { tasks: [8] } } } as unknown as LiveState))).toBe(false);
    expect(isForegroundRunning(view([]))).toBe(false);
  });

  it("leaves internal instructions out of chat and shows a native context-reset marker", () => {
    const projected = projectConversation(view([
      entry(1, [{ role: "system", content: "Internal instructions", timestamp: 1 }], "pi.system"),
      entry(2, [], "pi.reset"),
    ]));
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ id: "entry:2:notice", metadata: { custom: { entryId: 2, entryKind: "pi.reset" } } });
  });

  it.each([
    ["pi.reset", "Carry forward the agreed decision"],
    ["pi.compaction", "Summary of the preceding conversation"],
  ])("shows %s model context only in its context notice", (kind, text) => {
    const nativeEntry = entry(2, [{ role: "user", content: text, timestamp: 2 }], kind);
    const projected = projectConversation(view([nativeEntry]));
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: "entry:2:notice",
      role: "assistant",
      content: [{ type: "data", name: "pi-context", data: { kind, text } }],
    });
    expect(nativeEntry.model).toEqual([{ role: "user", content: text, timestamp: 2 }]);
  });

  it("sends only new text and image input to Pi", () => {
    const input = toPiUserInput({
      content: [{ type: "text", text: "Describe this" }, { type: "image", image: "data:image/png;base64,YWJj" }],
      attachments: [],
    } as unknown as AppendMessage);
    expect(input).toEqual([{ type: "text", text: "Describe this" }, { type: "image", mimeType: "image/png", data: "YWJj" }]);
  });

  it("renders a native context replacement without changing the original entry", () => {
    const original = entry(2, [{ role: "user", content: "Original question", timestamp: 2 }], "pi.user");
    const changed = {
      ...entry(8, [], "assistant-ui.context-edit"),
      edits: [{ target: 2, action: "replace", messages: [{ role: "user", content: "Revised question", timestamp: 8 }] }],
    } as unknown as EntryRecord;
    const projected = projectConversation(view([original, changed]));
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: "entry:2:0",
      content: [{ type: "text", text: "Revised question" }],
      metadata: { custom: { entryId: 2, editEntryId: 8 } },
    });
    expect(original.model?.[0]).toMatchObject({ content: "Original question" });
  });

  it("omits an old answer from the fork's rendered context after a native omission", () => {
    const oldAnswer = entry(4, [assistant([{ type: "text", text: "Old answer" }])]);
    const omission = { ...entry(8, [], "assistant-ui.context-edit"), edits: [{ target: 4, action: "omit" }] } as unknown as EntryRecord;
    const newAnswer = entry(9, [assistant([{ type: "text", text: "Regenerated answer" }])]);
    const projected = projectConversation(view([oldAnswer, omission, newAnswer]));
    expect(projected.map((message) => message.id)).toEqual(["entry:9:0"]);
    expect(oldAnswer.model?.[0]).toMatchObject({ content: [{ type: "text", text: "Old answer" }] });
  });

  it("restores feedback using the native answer entry ID", () => {
    const answer = entry(14, [assistant([{ type: "text", text: "An answer" }])]);
    const metadata = { title: "A conversation", feedback: { 14: "positive" }, suggestions: [] } as unknown as ConversationMetadata;
    const projected = projectConversation(view([answer]), metadata);
    expect(projected[0]?.metadata?.submittedFeedback).toEqual({ type: "positive" });
    expect(projected[0]?.metadata?.custom).toMatchObject({ entryId: 14 });
  });

  it("keeps tool output separate from UI artifacts", () => {
    const output = { ...result("child", "The child's actual answer"), details: { conversationId: 42 } };
    const projected = projectConversation(view([
      entry(1, [assistant([{ type: "toolCall", id: "child", name: "demo_subagent", arguments: {} }], "toolUse")]),
      entry(2, [output], "pi.tool-result"),
    ]));
    expect(projected[0]?.content).toEqual([expect.objectContaining({ result: "The child's actual answer", artifact: { conversationId: 42 }, modelContent: [{ type: "text", text: "The child's actual answer" }] })]);
  });

  it("preserves committed projection identity and leaves its tools unchanged across live updates", () => {
    const history = projectConversationHistory(view([
      entry(1, [{ role: "user", content: "Keep this message", timestamp: 1 }]),
      entry(2, [assistant([{ type: "toolCall", id: "progress", name: "demo_progress", arguments: {} }], "toolUse")]),
    ]).items);
    const first = projectConversationLive(history, { tools: [{ callId: "progress", name: "demo_progress", status: "running", output: "First progress" }] }, 1 as TranscriptView["conversation"]["id"]);
    const next = projectConversationLive(history, { tools: [{ callId: "progress", name: "demo_progress", status: "running", output: "Later progress" }] }, 1 as TranscriptView["conversation"]["id"]);
    expect(first[0]).toBe(next[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(first[1]?.content).toEqual([expect.objectContaining({ result: "First progress" })]);
    expect(next[1]?.content).toEqual([expect.objectContaining({ result: "Later progress" })]);
    expect(history.messages[1]?.content).toEqual([expect.not.objectContaining({ result: expect.anything() })]);
  });

  it("exposes durable human questions through Assistant UI text approval", () => {
    const projected = projectConversation(view([
      entry(1, [assistant([{ type: "toolCall", id: "question", name: "request_human_input", arguments: {} }], "toolUse")]),
    ], { tools: [{ callId: "question", name: "request_human_input", status: "running", details: { type: "human-input", taskId: 9, prompt: "Which direction?", status: "pending" } }] }));
    expect(projected[0]?.content).toEqual([expect.objectContaining({ approval: { id: "9", display: "text", prompt: "Which direction?" } })]);
  });

  it("projects native run failures that have no assistant message", () => {
    const projected = projectConversation(view([], { runFailure: { taskId: 9, inputs: [], reason: "no_model", detail: "No registered model" } } as unknown as LiveState));
    expect(projected).toEqual([expect.objectContaining({ id: "failure:9", status: { type: "incomplete", reason: "error", error: "No registered model" } })]);
  });

});
