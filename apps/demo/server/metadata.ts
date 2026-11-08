import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  type ConversationId,
  type ConversationRecord,
  type EntryId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ConversationMetadata, ConversationMetadataPatch } from "@usecontextlayer/pi-durable-assistant-ui";
import { NotFoundError } from "./errors.js";

function initialMetadata(): ConversationMetadata {
  return {
    title: null,
    archived: false,
    feedback: {},
    suggestions: [
      "Explain how this conversation remembers context",
      "Help me plan a small task",
      "Show me what you can do",
    ],
  };
}

export const ConversationMetadataDoc = defineDoc<ConversationMetadata>({
  kind: "demo.presentation",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is a new thread: its title, archive state and local feedback start fresh.
  fork: "initial",
  initial: initialMetadata,
  checkpointWhen: () => false,
});

function copyMetadata(value: Readonly<ConversationMetadata>): ConversationMetadata {
  return { ...value, feedback: { ...value.feedback }, suggestions: [...value.suggestions] };
}

async function conversation(harness: Harness, id: ConversationId, context: Context) {
  const value = await harness.conversation(id, context);
  if (!value) throw new NotFoundError("Conversation not found.");
  return value;
}

/** Use as HarnessOptions.conversationCreated, including for native forks. */
export async function initializeConversationMetadata(tx: Tx, record: ConversationRecord): Promise<void> {
  await tx.doc(ConversationMetadataDoc, record.id);
}

/** Missing metadata in older conversations reads as defaults without creating state. */
export async function getConversationMetadata(
  harness: Harness,
  id: ConversationId,
  context: Context,
): Promise<ConversationMetadata> {
  await conversation(harness, id, context);
  return copyMetadata(await harness.snapshot(ConversationMetadataDoc, id, context) ?? initialMetadata());
}

export async function updateConversationMetadata(
  harness: Harness,
  id: ConversationId,
  update: ConversationMetadataPatch,
  context: Context,
): Promise<ConversationMetadata> {
  const value = await conversation(harness, id, context);
  return value.commit(async (tx) => {
    const metadata = await tx.doc(ConversationMetadataDoc, id);
    if (update.title !== undefined) metadata.title = update.title;
    if (update.archived !== undefined) metadata.archived = update.archived;
    if (update.suggestions !== undefined) metadata.suggestions = [...update.suggestions];
    return copyMetadata(metadata);
  }, context);
}

export async function setConversationFeedback(
  harness: Harness,
  id: ConversationId,
  entryId: EntryId,
  feedback: ConversationMetadata["feedback"][EntryId] | null,
  context: Context,
): Promise<ConversationMetadata> {
  const value = await conversation(harness, id, context);
  const page = await value.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, context);
  if (!page.items.some((entry) => entry.id === entryId)) throw new Error("Feedback entry not found in this conversation.");
  return value.commit(async (tx) => {
    const metadata = await tx.doc(ConversationMetadataDoc, id);
    if (feedback === null) delete metadata.feedback[entryId];
    else metadata.feedback[entryId] = feedback;
    return copyMetadata(metadata);
  }, context);
}

export async function listConversationMetadata(
  harness: Harness,
  records: readonly ConversationRecord[],
  context: Context,
): Promise<(ConversationMetadata & Pick<ConversationRecord, "id">)[]> {
  return Promise.all(records.map(async ({ id }) => ({ id, ...await getConversationMetadata(harness, id, context) })));
}
