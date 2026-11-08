import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { ConversationId, Cursor } from "@earendil-works/pi-durable";
import type { PiDurableClient } from "./client.js";
import type { ConversationMetadata } from "./metadata.js";

type RemoteThreadMetadata = Awaited<ReturnType<RemoteThreadListAdapter["fetch"]>>;

export function nativeConversationId(value: string): ConversationId {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid Pi conversation ID: ${value}`);
  return id as ConversationId;
}

export function createPiDurableThreadListAdapter(client: PiDurableClient, pageSize = 50): RemoteThreadListAdapter {
  const metadata = (id: ConversationId, details?: ConversationMetadata): RemoteThreadMetadata => ({
    remoteId: String(id), status: "regular", title: details?.title ?? `Conversation ${id}`,
  });
  return {
    async list({ after } = {}) {
      const page = await client.listConversations({}, pageSize, after ? JSON.parse(after) as Cursor : undefined);
      const details = client.listMetadata ? await client.listMetadata(page.items.map((item) => item.id)) : undefined;
      const threads = await Promise.all(page.items.map(async ({ id }) => metadata(id, details?.[String(id)] ?? await client.getMetadata?.(id))));
      return { threads, ...(page.next ? { nextCursor: JSON.stringify(page.next) } : {}) };
    },
    async initialize() {
      return { remoteId: String((await client.createConversation()).id) };
    },
    async fetch(remoteId) {
      const id = nativeConversationId(remoteId);
      if (client.getMetadata) return metadata(id, await client.getMetadata(id));
      await client.getConversationView(id);
      return metadata(id);
    },
    async rename(remoteId, title) {
      if (!client.updateMetadata) throw new Error("This Pi host does not expose conversation titles");
      await client.updateMetadata(nativeConversationId(remoteId), { title });
    },
    async archive() { throw new Error("Pi Durable does not support archiving conversations."); },
    async delete() { throw new Error("Pi Durable does not support deleting conversations."); },
    async generateTitle() {
      return new ReadableStream<never>({ start(controller) { controller.close(); } });
    },
  };
}
