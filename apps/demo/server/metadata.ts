import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ConversationMetadata, ConversationMetadataPatch } from "@usecontextlayer/pi-durable-assistant-ui";
import { NotFoundError } from "./errors.js";

function initialMetadata(): ConversationMetadata {
  return {
    title: null,
    feedback: {},
    suggestions: [
      "Explain how this conversation remembers context",
      "Help me plan a small task",
      "Show me what you can do",
    ],
  };
}

export const ConversationMetadataDoc = defineDoc<ConversationMetadata>({
  kind: "demo.metadata",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is a new thread: its title and local feedback start fresh.
  fork: "initial",
  initial: initialMetadata,
  checkpointWhen: () => true,
});

const LegacyPresentationDoc = defineDoc<ConversationMetadata>({
  ...ConversationMetadataDoc.definition,
  kind: "demo.presentation",
  history: "latest",
  fork: "initial",
});

function copyMetadata(value: Readonly<ConversationMetadata>): ConversationMetadata {
  return { title: value.title, feedback: { ...value.feedback }, suggestions: [...value.suggestions] };
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

/** Upgrade existing conversations before the host resumes tasks or accepts requests. */
export async function upgradeConversationMetadata(harness: Harness, context: Context): Promise<void> {
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 100, cursor), context);
    for (const { id } of page.items) {
      if (await harness.snapshot(ConversationMetadataDoc, id, context)) continue;
      const legacy = await harness.snapshot(LegacyPresentationDoc, id, context);
      await harness.commit(async (tx) => {
        const metadata = await tx.doc(ConversationMetadataDoc, id);
        if (legacy) {
          Object.assign(metadata, copyMetadata(legacy));
          await tx.retireDoc(LegacyPresentationDoc, id);
        }
      }, context);
    }
    cursor = page.next;
  } while (cursor);
}

export async function getConversationMetadata(
  harness: Harness,
  id: ConversationId,
  context: Context,
): Promise<ConversationMetadata> {
  const metadata = await harness.snapshot(ConversationMetadataDoc, id, context);
  if (!metadata) throw new NotFoundError("Conversation metadata not found.");
  return copyMetadata(metadata);
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
  ids: readonly ConversationId[],
  context: Context,
): Promise<Record<string, ConversationMetadata>> {
  return Object.fromEntries(await Promise.all(ids.map(async (id) => [String(id), await getConversationMetadata(harness, id, context)])));
}
