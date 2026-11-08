import { expect, it, vi } from "vitest";
import { CompositeAttachmentAdapter, type AppendMessage } from "@assistant-ui/react";
import { createPiDurableAttachmentAdapter } from "./attachments.js";
import { toPiUserInput } from "./projection.js";

it("accepts images and ordinary files through Assistant UI's attachment filter", async () => {
  const adapter = new CompositeAttachmentAdapter([createPiDurableAttachmentAdapter(vi.fn())]);
  for (const file of [new File(["image"], "plot.png", { type: "image/png" }), new File(["text"], "notes.txt", { type: "text/plain" }), new File(["data"], "unknown")]) {
    await expect(adapter.add({ file })).resolves.toMatchObject({ name: file.name, file });
  }
});

it("uploads a file only when sent and preserves the host's native path input", async () => {
  const file = new File(["A project document"], "project.txt", { type: "text/plain" });
  const upload = vi.fn(async () => ({ name: file.name, content: [{ type: "text" as const, text: "Read /workspace/uploads/project.txt" }] }));
  const adapter = createPiDurableAttachmentAdapter(upload);
  const pending = await adapter.add({ file });
  if (!("status" in pending)) throw new Error("Expected a pending attachment");
  expect(upload).not.toHaveBeenCalled();
  const complete = await adapter.send(pending);
  expect(upload).toHaveBeenCalledOnce();
  expect(toPiUserInput({ content: [{ type: "text", text: "Summarize this" }], attachments: [complete] } as unknown as AppendMessage)).toEqual([
    { type: "text", text: "Summarize this" },
    { type: "text", text: "Read /workspace/uploads/project.txt" },
  ]);
});

it("uses image bytes returned by the host and forwards send cancellation", async () => {
  const file = new File(["image"], "plot.png", { type: "image/png" });
  const upload = vi.fn(async (_file: File, _signal?: AbortSignal) => ({ name: file.name, content: [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }] }));
  const adapter = createPiDurableAttachmentAdapter(upload);
  const pending = await adapter.add({ file });
  if (!("status" in pending)) throw new Error("Expected a pending attachment");
  const controller = new AbortController();
  const complete = await adapter.send(pending, { signal: controller.signal });
  expect(upload).toHaveBeenCalledWith(file, controller.signal);
  expect(toPiUserInput({ content: [], attachments: [complete] } as unknown as AppendMessage)).toEqual([{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
});
