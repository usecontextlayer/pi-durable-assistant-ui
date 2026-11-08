# Feature coverage

The integration uses Pi Durable/AI/Chord 1.5.0 and Assistant UI 0.15.32. Pi owns persistent execution, records and identifiers. Presentation extensions also use Pi's own documents. The full native/unit suite passes 44 tests; all eight browser workflows pass together. These counts describe observed runs, not every possible combination of features.

| Capability | Native owner and integration | Evidence / actual boundary |
| --- | --- | --- |
| Create, list, select, reopen | Native conversation IDs, paged directory, Assistant UI thread list | Native conversation tests and browser create/switch/reload workflow |
| Text, Markdown, reasoning, live state | Native view/Chord operations → ConversationTranscript → ExternalStoreRuntime | Projection tests, actual browser streaming, real Haiku conversation |
| Submissions and exact answers | Native submission status and answer entry | Conversation integration tests; native request IDs retained |
| Follow-up, steering, continuation | Native submit policies and inbox | Native tests and composer follow-up/steer controls; continue control |
| Withdraw versus cancel | Native submission withdrawal and conversation abort | Separate tests prove the different outcomes; UI exposes both |
| Browser disconnect/reconnect | Observer lifetime independent of Pi execution | Two-browser test cuts an active SSE connection and blocks reconnects; the other browser receives the answer, then the disconnected browser catches up automatically with the same native entry ID and no duplicate rows |
| Multiple browser sessions | Independent watches of the same native conversation | Two isolated Chromium contexts receive partial output, preserve execution when one disconnects, and receive submissions from either browser |
| Persistence and recovery | Native SQLite, Harness close/resume | Reopen tests retain history; background task and pending human-input tests recover native work |
| Earlier history and gaps | Native ConversationTranscript | Tests page past bounded watches; direct binding verifies 115 entries with no duplicate IDs |
| Configuration | Native configure plus registry lookup of serialized tool/extension names | HTTP tests prove registered name selections, omitted/null semantics and filters; browser tests prove a late model catalog preserves the selected native model when another setting is saved |
| Current instructions and creation defaults | Registered section renderers and native creation configuration | Existing conversation uses replaced renderer; changed creation defaults leave its configuration alone |
| Fork/edit/regenerate | Native forks and immutable context replacement/omission | Native tests and browser workflow; real Haiku edited retry; edited-input fork targets its latest edit entry |
| Branch navigation | Each fork is its own native conversation/thread | Sidebar and native parent/child links; no synthetic in-thread branch store |
| Reset, handoff and compaction | Native reset/handoff, manual and automatic compaction | Native tests preserve retained history while changing active context; browser reset/handoff workflow |
| Tools and errors | Pi CodingTools and registered demo extensions | Actual read/write/edit/bash, parallel/nested calls, tool errors, partial progress and native image results tested |
| Tool rendering | Assistant UI named and generic renderers | File/shell renderers, live details, errors, images/files; browser tools/image workflow |
| Images and files | Native image blocks; local files referenced through native file tools | Attachment filter regression, upload/download/read tests, actual browser PNG upload and rendering |
| Usage and task inspection | Native usage records and HarnessInspection | Collapsible UI with native task/submission records and refresh; background tests distinguish parent completion from child work |
| Foreground/background children | Native child ownership and durable background tasks | Real native scenarios; background recovery proves one child and one report after reopen |
| Titles, archive and feedback | Native demo.presentation conversation document | SQLite reopen/fork/reset tests; browser rename/archive/unarchive/feedback workflow |
| Suggestions | Native presentation document with static defaults | Suggestions render through Assistant UI; no extra model call or synthetic answer |
| Durable human input | Replay-safe native tool, task document and watchDoc | Same task/call after restart; browser pending → reload → response → original native tool result |
| Speech and dictation | Official Assistant UI browser adapters, support-gated controls | Integrated and typechecked; actual microphone capture and audible playback have not been verified. Browser/device permission remains required |
| Real-model operation | Native Anthropic provider, Haiku-only catalog | Live Haiku response and browser edited retry completed with exact native outcomes |
| Independent host consumption | Structural PiClient; separately built package | Same adapter/store runs over HTTP/SSE and a direct native binding; no demo import in the adapter |

Current synchronization limitation: live conversation watches synchronize messages and execution across browsers, but the conversation directory and presentation metadata have no cross-browser push subscription. Creating a conversation, renaming, archiving or leaving feedback in one browser does not immediately refresh another. Reopening/refreshing the directory, reconnecting the selected conversation, and completion of observed work trigger the relevant reads; the adapter's explicit refresh actions are also available. This is a limitation of the current integration, not a restriction imposed by Pi.

## Deliberate semantic boundaries

Permanent conversation deletion is not exposed: the inspected Pi 1.5 API has no general deletion operation. Archive preserves history.

The inbox exposes native submission controls. Atomic editing or arbitrary reordering of an accepted queue is not exposed by the inspected Pi API. Withdrawal followed by a new submission creates a new native ID; the demo supports those explicit operations and does not advertise an in-place queue editor or supply a second queue engine.

Native forks are separate Assistant UI threads. The ordinary Assistant UI branch widget does not conceal multiple native conversations behind a single thread ID.

Interactive tools use the demonstrated native extension, not an arbitrary browser injection of tool results. The pending tool remains a running invocation observing native document state; restart reconstructs it. This is not scheduler-level parking on a document.

Browser speech/dictation converts ordinary Pi text. A realtime voice-agent protocol, audio/video model input, external speech provider and model training from feedback are not claimed. Uploaded non-image documents are files available to native tools, not fictional native document-message types.

Pi resumes durable execution, not arbitrary operating-system processes. Native unsafe-tool interruption semantics still apply. Forks do not clone filesystem state.

## Verification sources

- `packages/adapter/src/*.test.ts`: projection, stable identity, native context edits, attachment filtering, metadata/directory loading.
- `tests/conversations.test.ts`: native lifecycle, submissions, queue, abort, forks, reset, compaction, current renderers, history.
- `tests/media-tools.test.ts`: actual file/image input and native tool execution/projection.
- `tests/interaction.test.ts`: human input on the original native tool, including host restart.
- `tests/metadata.test.ts`: native presentation-document persistence and fork policy.
- `tests/portability.test.ts`: direct native binding, background recovery and serialized registry configuration.
- `tests/e2e/conversations.spec.ts`: eight real Chromium UI workflows.

Native references: [Pi Durable 1.5](https://github.com/earendil-works/pi/tree/v1.5.0/packages/durable) and [Assistant UI ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store). Package versions are pinned in pnpm-lock.yaml.
