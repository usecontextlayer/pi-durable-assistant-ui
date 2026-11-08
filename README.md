<div align="center">

# Pi Durable + Assistant UI

An [Assistant UI](https://www.assistant-ui.com) runtime adapter for [Pi Durable](https://github.com/earendil-works/pi/tree/v1.5.0/packages/durable), with a local demo you can run without an API key.

</div>

```sh
pnpm install --frozen-lockfile
pnpm dev
# Open http://127.0.0.1:5173 and send /tool to run a local shell tool.
```

- **One thread, one conversation.** Pi owns the identifiers, history, submissions, and execution. Assistant UI renders them.
- **Keep running after disconnect.** Close the browser while the agent works, then reconnect to its current state. Multiple browsers can watch the same conversation.
- **Exercise native Pi features.** Stream text and tool results, upload files, edit and fork conversations, steer work, and respond to durable human-input requests.
- **Bring your own host and UI.** Use the adapter with Assistant UI components and a `PiClient` implementation. The adapter has no dependency on the demo server.

## Try the demo

Requires Node 22.19 or newer and pnpm 11.22.0. Run the commands above from this checkout. The default provider streams deterministic responses without credentials and executes real native tools. Send `/long` to watch a longer response or `/error` to see a provider failure.

Conversations persist in `.data/pi.sqlite`; file and shell tools use `.data/workspace`. The local server can execute shell commands on your machine, so keep its configured loopback binding.

For model conversations, add `ANTHROPIC_API_KEY` to the ignored root `.env.local`, then run:

```sh
PI_PROVIDER=anthropic PI_MODEL=claude-haiku-5-5 pnpm dev
```

The demo registers Haiku models only. Keys stay on the server. See [Developing](DEVELOPING.md) for configuration, deterministic scenarios, and verification commands.

## Use the adapter

[`@usecontextlayer/pi-durable-assistant-ui`](https://www.npmjs.com/package/@usecontextlayer/pi-durable-assistant-ui) provides `usePiRuntime`, `PiRuntimeStore`, an HTTP/SSE client, attachment support, and message projection. `usePiRuntime` supplies an Assistant UI `ExternalStoreRuntime`; your application supplies the components. See the [adapter README](packages/adapter/README.md) for installation and integration.

The [demo UI](apps/demo/src/App.tsx) composes Assistant UI primitives with Pi controls, tool renderers, and task inspection. Those components and the [local Node host](apps/demo/server/local-client.ts) are demo source, separate from the adapter package.

## How it works

The host exposes native Pi operations and a conversation watch. The HTTP client receives an initial view followed by Chord updates; Pi's `ConversationTranscript` handles earlier history and reconnect gaps. The adapter projects that state into Assistant UI without persisting another transcript. Native forks appear as separate conversations.

Messages and execution update across connected browsers. The conversation list, titles, archive state, and feedback refresh through reads rather than a cross-browser subscription. See [feature coverage](FEATURES.md) for verified behavior and the exact support boundaries.
