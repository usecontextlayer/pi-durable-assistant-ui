import type { EntryId } from "@earendil-works/pi-durable";

/** Presentation data persisted by the host in a native conversation document. */
export type ConversationMetadata = {
  title: string | null;
  archived: boolean;
  feedback: Record<EntryId, "positive" | "negative">;
  suggestions: string[];
};

export type ConversationMetadataPatch = Partial<Pick<ConversationMetadata, "title" | "archived" | "suggestions">>;

export const EMPTY_CONVERSATION_METADATA: ConversationMetadata = {
  title: null,
  archived: false,
  feedback: {},
  suggestions: [],
};
