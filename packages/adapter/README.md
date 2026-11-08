<div align="center">

# Pi Durable for Assistant UI

Render [Pi Durable](https://github.com/earendil-works/pi/tree/v1.5.0/packages/durable) conversations with [Assistant UI](https://www.assistant-ui.com) while Pi owns history and execution.

</div>

```tsx
import type { ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { createHttpPiClient, usePiRuntime } from "@usecontextlayer/pi-durable-assistant-ui";
const client = createHttpPiClient({ baseUrl: "/api" });
```

```tsx
export function PiChat({ children }: { children: ReactNode }) {
  const { runtime } = usePiRuntime({ client });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

- **Use Assistant UI components.** The hook supplies an `ExternalStoreRuntime` for your thread, composer, and conversation list.
- **Keep Pi as the source of truth.** One thread maps to one native conversation. The browser stores no second durable transcript and runs no model.
- **Reconnect to ongoing work.** Streaming, earlier history, and reconnect gaps use native Pi views and `ConversationTranscript`. Closing a subscription does not cancel execution.
- **Choose your host.** Implement `PiClient` or use the included HTTP/SSE client with the demo's protocol. The adapter has no dependency on the demo's Node/SQLite host.

## Use it locally

The package is currently named `@usecontextlayer/pi-durable-assistant-ui` and has not been published. It builds as ESM with TypeScript declarations. It requires React 19 and `@assistant-ui/react` 0.15.32; Pi Durable, Pi AI, and Chord are pinned to 1.5.0.

From the workspace root, build and pack it:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/pi-durable-assistant-ui
pnpm --dir packages/adapter pack
```

Install the resulting tarball in your application and supply the React and Assistant UI peers. Keep the client instance stable, as in the example above, and render your Assistant UI components inside `PiChat`. This package supplies the runtime integration, not the demo's components or server.

## Runtime and actions

`usePiRuntime` returns `{ runtime, state, actions }`. `state` exposes the native conversation directory, selected ID, merged transcript view, rendered messages, running/connection/loading state, errors, and metadata. `actions` exposes conversation selection and creation, earlier-history loading, submissions, continuation, steering, withdrawal, configuration, cancellation, forks, reset, and compaction where the client supports them.

Pass `initialConversationId` to reopen a native conversation, for example an ID saved in your URL. It applies when the store is constructed; later navigation uses `actions.selectConversation(id)`. `whenBusy` selects Pi's `followUp`, `steer`, or `reject` submission behavior.

For use outside React, `PiRuntimeStore` exposes the same actions with `start`, `stop`, `subscribe`, and `getSnapshot`. `projectConversation` supplies the pure message projection.

## Host contract

`PiClient` is a structural interface whose optional methods describe host capabilities. Assistant UI callbacks are enabled only when the corresponding capability exists. The included `createHttpPiClient` returns `Required<PiClient>` and expects the demo's native-operation routes: an ordinary Pi host does not acquire those routes simply by installing this package.

The HTTP watch carries an initial `ConversationView` and subsequent Chord operations over SSE. Pi's `ConversationTranscript` merges the bounded live view with earlier history and supplies reconnect windows. The host owns execution independently of each browser's watch.

Conversation and entry IDs remain Pi's IDs; their string representations are UI keys. Live generation uses a native task-derived key until its immutable entry arrives. Projection matches tool results by native call ID, retains partial output, separates foreground generation from after-run activity, and leaves internal instruction entries out of chat. Raw history remains available through `state.view`.

`SerializedAgentChange` carries JSON configuration with registered tool, extension, and model-tool names. The host resolves those names before native configuration; omitted fields are unchanged and `null` clears a field.

## Edits and forks

Editing forks at the original input, records a native context replacement, and continues the new conversation. Regeneration forks at the selected answer, omits it from the fork's model context through a native context edit, and continues. The original immutable history stays available.

Each native fork is a separate thread. No hidden in-thread branch store or `setMessages` callback overwrites Pi history.

## Attachments and extensions

Pass `createPiAttachmentAdapter(client.uploadFile)` as the hook's `attachments` option when the host supports uploads. Uploads happen on send. `PiUploadResult` requires only `name` and `content`, an array of native Pi input blocks: images can remain image blocks; other files can be paths readable by native tools. The adapter returns Assistant UI's standard `CompleteAttachment`. The host owns storage; paths, download URLs, sizes and content types are not required by the adapter. Removing a draft attachment does not delete an uploaded workspace file.

The hook accepts Assistant UI's `speech`, `dictation`, and `feedback` adapters. For browser voice controls, use `WebSpeechSynthesisAdapter` and support-gated `WebSpeechDictationAdapter` from Assistant UI. No speech provider is built into this package; browser support and permissions remain the consumer's responsibility.

The optional `respondToHumanInput` client operation sends a response to a host's durable human-interaction extension. It answers the native task rather than fabricating a browser-side tool result.

## Titles, archive, and feedback

Optional metadata methods support titles, archive state, feedback keyed by native entry ID, and suggestions. The demo persists these in a native Pi conversation document. Such custom metadata is not included in `ConversationView.docs`, so the adapter reads it explicitly. Archiving preserves history; no permanent-delete operation is invented.

The directory follows native pagination and loads metadata in bulk. Starting observation and completing observed work refresh the directory; connecting or reconnecting the selected conversation refreshes its metadata. Mutations publish the host's returned metadata. There is no cross-browser subscription for the directory or metadata: changes made elsewhere appear on the next applicable read or explicit refresh. Messages and execution remain live through the conversation watch. `state.metadata` uses stringified native conversation IDs as keys.
