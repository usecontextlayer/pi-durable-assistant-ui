import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId, ConversationWatch, Cursor } from "@earendil-works/pi-durable";
import type { PiClient } from "@usecontextlayer/pi-durable-assistant-ui";
import type { LocalPiHost } from "./host.js";
import { storeUploadedFile } from "./env.js";
import { respondToHumanInput } from "./interaction.js";
import { resolveAgentChange } from "./agent-change.js";
import { NotFoundError } from "./errors.js";
import { getConversationMetadata, listConversationMetadata, setConversationFeedback, updateConversationMetadata } from "./metadata.js";

/** The local host's native binding, shared by HTTP and direct adapter consumers. */
export function createLocalPiClient(piHost: LocalPiHost): Required<PiClient> {
  const { harness } = piHost;
  const context = BACKGROUND_CONTEXT;
  const conversation = async (id: ConversationId) => {
    const value = await harness.conversation(id, context);
    if (!value) throw new NotFoundError("Conversation not found.");
    return value;
  };

  return {
    listConversations: (query = {}, limit = 100, cursor) => harness.commit(
      (tx) => tx.scanConversations(query, limit, cursor), context,
    ),
    async createConversation(options = { ownership: { kind: "ownerless" } }) {
      const created = await harness.createConversation({
        ...options,
        agent: { ...piHost.defaultAgent, ...resolveAgentChange(options.agent ?? {}, piHost.registry) },
      }, context);
      return (await created.commit((tx) => tx.conversation(created.id), context))!;
    },
    async getConversationView(id) {
      const watch = await (await conversation(id)).watch(context);
      const value = watch.value;
      await watch.stop();
      return value;
    },
    async entries(id, query, limit, cursor, signal) {
      return (await conversation(id)).entries(query, limit, cursor, signal ? withAbortSignal(signal, context) : context);
    },
    async submit(id, draft) {
      return (await (await conversation(id)).submit(draft, context)).status(context);
    },
    async getSubmission(id) {
      const submission = await harness.submission(id, context);
      if (!submission) throw new NotFoundError("Submission not found.");
      return submission.status(context);
    },
    watch(id, onView, options = {}) {
      let disposed = false;
      let observation: ConversationWatch | undefined;
      options.onConnection?.("connecting");
      void (async () => {
        observation = await (await conversation(id)).watch(context, options.window?.());
        if (disposed) {
          await observation.stop();
          return;
        }
        options.onConnection?.("connected");
        onView(observation.value);
        observation.start(async (change) => {
          if (!disposed && change.kind === "value") onView(change.value);
        });
      })().catch((cause: unknown) => {
        if (!disposed) options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
      });
      return () => {
        disposed = true;
        void observation?.stop();
      };
    },
    configure: async (id, change) => (await conversation(id)).configure(resolveAgentChange(change, piHost.registry), context),
    abort: async (id, options) => (await conversation(id)).abort(context, options),
    abortSubmission: (id) => harness.abortSubmission(id, context),
    reset: async (id, handoff) => (await conversation(id)).reset(handoff, context),
    compact: async (id, instructions) => (await conversation(id)).compact(instructions, context),
    async fork(id, at, options = { ownership: { kind: "ownerless" } }) {
      const fork = await (await conversation(id)).fork(at, {
        ...options,
        agent: options.agent === undefined ? undefined : resolveAgentChange(options.agent, piHost.registry),
      }, context);
      return (await fork.commit((tx) => tx.conversation(fork.id), context))!;
    },
    context: async (id, at) => (await conversation(id)).context(context, at === undefined ? {} : { at }),
    async uploadFile(file) {
      return storeUploadedFile(piHost.paths, {
        name: file.name,
        contentType: file.type || "application/octet-stream",
        data: new Uint8Array(await file.arrayBuffer()),
      });
    },
    async respondToHumanInput(taskId, response) {
      await respondToHumanInput(harness, taskId, response, context);
    },
    inspect: () => harness.inspect(context),
    async listMetadata() {
      const records = [];
      let cursor: Cursor | undefined;
      do {
        const page = await harness.commit((tx) => tx.scanConversations({}, 100, cursor), context);
        records.push(...page.items);
        cursor = page.next;
      } while (cursor);
      const metadata = await listConversationMetadata(harness, records, context);
      return Object.fromEntries(metadata.map(({ id, ...value }) => [String(id), value]));
    },
    getMetadata: (id) => getConversationMetadata(harness, id, context),
    updateMetadata: (id, patch) => updateConversationMetadata(harness, id, patch, context),
    setFeedback: (id, entryId, rating) => setConversationFeedback(harness, id, entryId, rating, context),
  };
}
