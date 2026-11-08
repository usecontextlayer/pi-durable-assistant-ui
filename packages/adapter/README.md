# Pi Durable for Assistant UI

Render native Pi Durable conversations through Assistant UI. Pi owns durable history, execution, submissions and configuration; Assistant UI owns thread navigation, drafts, initialization and directory pagination.

## Build and consume

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@usecontextlayer/pi-durable-assistant-ui
pnpm --dir packages/adapter pack
```

Install the resulting tarball into your application, together with React 19, `@assistant-ui/react` compatible with `^0.15.32`, and Pi Durable compatible with `^1.5.0`. Pi Durable is a peer because native branded identifiers cross the host boundary. The checkout pins its verification dependencies in pnpm-lock.yaml. The adapter builds as ESM with TypeScript declarations and does not depend on the demo's Node/SQLite host.

```tsx
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  createHttpPiDurableClient,
  usePiDurableRuntime,
} from "@usecontextlayer/pi-durable-assistant-ui";

const client = createHttpPiDurableClient({ baseUrl: "/api" });

export function PiChat({ children }: { children: React.ReactNode }) {
  const runtime = usePiDurableRuntime({ client });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

Keep the client stable. `usePiDurableRuntime` returns the standard Assistant UI runtime, so thread selection and directory actions use Assistant UI's APIs and primitives. Pass a controlled native `threadId` and `onThreadIdChange` to connect navigation to a URL. New threads are framework drafts until their first send initializes a native conversation. Assistant UI's temporary local identifiers remain internal; the canonical remote ID is the string representation of the native Pi conversation ID. Forks select their own native conversation as another thread.

The remote runtime retains visited thread runtimes until its lifecycle releases them. Each initialized thread owns a `PiDurableConversation`, its native `ConversationTranscript`, conversation observation and optional metadata observation. Closing an observation never cancels agent execution. Directory pages load on demand; the adapter reads metadata only for that page and does not rescan the entire directory after every answer.

## Native state and actions

Inside `AssistantRuntimeProvider`, `usePiDurable()` reads the current thread's `{ conversation, state }` extras. `conversation` is undefined for a draft; otherwise its ID and all its actions are bound to one native conversation. `state` contains the merged native view, metadata, transport connection/loading state and an error when one is reported. Native controls can use submission, continuation, steering, withdrawal, cancellation, configuration, forks, reset, compaction and earlier-history operations where the host supplies them.

For direct non-React observation, construct `new PiDurableConversation(client, id, pageSize)`, subscribe with `subscribe`/`getSnapshot`, then call `start` and `stop`. It has no selection method or global directory. Edit and regeneration return a native fork and target both the context write and continuation explicitly at that fork; the React integration then asks Assistant UI to select it.

## Host contract and observation

Implement the structural `PiDurableClient` or use `createHttpPiDurableClient` with the demo protocol. Installing the adapter does not install server routes. Optional client methods describe host extensions; titles, feedback, suggestions, uploads and human input require the corresponding host implementation.

`watch` returns Pi/Chord's standard asynchronous watch handle: current immutable `value`, `start`, `stop` and terminal `closed` outcome. HTTP carries an initial view, native Chord operations, recoverable source failures and terminal outcomes over one shared SSE connection per client. Logical subscriptions are tagged independently so retained thread runtimes do not exhaust browser HTTP connection limits. It reconstructs the same watch contract in the browser using Chord. Transport reconnection status remains separate from source termination. Native acquisition failures and terminal outcomes close the source rather than retrying indefinitely. Resume windows come from the thread's native transcript.

`watchMetadata`, when supplied, observes the host's native metadata document. The demo uses a conversation document for title, feedback keyed by native entry ID and static suggestions, with checkpoints on updates. The native creation hook initializes the document for each conversation, including forks. Native conversation views do not include arbitrary custom documents. Metadata changes update mounted conversations live; an observed title change refreshes Assistant UI's directory through its reload API. Newly created conversations from another client appear on explicit directory refresh. The optional batch metadata operation accepts only the IDs in the requested directory page.

`SerializedAgentChange` carries JSON tool, extension and model-tool names; the host resolves those names into registered native definitions. Omitted fields remain unchanged and null clears a field. Host-specific registry and execution-environment choices remain outside the adapter.

## Message semantics

The projection uses native entry IDs, joins tool results by native call ID and marks transient live messages optimistic so Assistant UI can evict them when committed entries arrive. Tool output is distinct from its UI-only artifact; native image output remains available as model content. The exported `PiDurableHumanInputDetails` artifact contract (native task ID, prompt, pending/answered status and answered response) becomes a text tool-approval request, and `onRespondToToolApproval` calls the host response operation for the native task. A response does not fabricate a browser-side tool result.

Reset and compaction notices are named `pi-context` data parts. Consumers register their own data renderer; the demo supplies one. Native entry guards classify those notices. Committed-history projection is memoized separately from live execution so unchanged message objects survive streaming updates. The pure `projectConversation` export remains available for non-React consumers.

## Queue and unsupported operations

The standard composer can send during a run through a queue adapter backed by Pi's native inbox. Assistant UI's normal busy send steers; `aui.composer().send({ steer: false })` enqueues a follow-up. Queue items retain native submission IDs, and removing one withdraws that submission. Pi owns processing and cancellation behavior; the adapter does not drain a second queue.

Pi Durable 1.5.0 has no native queue move/edit, permanent conversation deletion, archive or unarchive operation. Required delete, archive and queue move/edit methods reject explicitly; optional unarchive is omitted so Assistant UI reports that capability as unavailable. The demo exposes none of those controls. Archive is not simulated with a custom document. Withdrawal followed by another submission remains two distinct native operations with a new ID. Unsupported operations never report success.

## Attachments, feedback and voice

`createPiDurableAttachmentAdapter(client.uploadFile)` uses Assistant UI's attachment lifecycle and returns `CompleteAttachment`. The uploader supplies a name and native Pi input blocks; host storage paths, download URLs and content types remain host concerns. Removing a draft attachment does not delete an uploaded file from the host workspace.

Pass Assistant UI's `speech`, `dictation`, `attachments` and optional `feedback` adapters directly to the runtime hook. Without a feedback override, the native host feedback extension is used when available. Browser speech and dictation use Assistant UI's official adapters and support checks; actual microphone capture and audible playback remain device-dependent and unverified in this project.
