import type { EntryId } from "@earendil-works/pi-durable";

/** Presentation data persisted by the host in a native conversation document. */
export type ConversationMetadata = {
  title: string | null;
  feedback: Record<EntryId, "positive" | "negative">;
  suggestions: string[];
};

export type ConversationMetadataPatch = Partial<Pick<ConversationMetadata, "title" | "suggestions">>;

export const EMPTY_CONVERSATION_METADATA: ConversationMetadata = {
  title: null,
  feedback: {},
  suggestions: [],
};
