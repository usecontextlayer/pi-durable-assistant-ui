import type { AttachmentAdapter, CompleteAttachment } from "@assistant-ui/react";
import type { PiDurableUploadResult } from "./client.js";

/** Uploads at send time; the host decides which native Pi input represents the file. */
export function createPiDurableAttachmentAdapter(upload: (file: File, signal?: AbortSignal) => Promise<PiDurableUploadResult>): AttachmentAdapter {
  return {
    accept: "*",
    async add({ file }) {
      return { id: crypto.randomUUID(), type: file.type.startsWith("image/") ? "image" : "file", name: file.name, contentType: file.type, file, status: { type: "requires-action", reason: "composer-send" } };
    },
    async send(attachment, options): Promise<CompleteAttachment> {
      const uploadResult = await upload(attachment.file, options?.signal);
      return {
        ...attachment,
        status: { type: "complete" },
        content: uploadResult.content.map((part) => part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", image: `data:${part.mimeType};base64,${part.data}`, filename: uploadResult.name }),
      };
    },
    async remove() {
      // Removing a draft attachment does not delete an ordinary file from the host's workspace.
    },
  };
}
