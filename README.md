<div align="center">

# Pi Durable + Assistant UI

A community-maintained integration between [Pi Durable](https://github.com/earendil-works/pi/tree/v1.5.0/packages/durable) and [Assistant UI](https://www.assistant-ui.com), with a reusable runtime adapter and a local demo you can run without an API key.

</div>

```sh
pnpm add @usecontextlayer/pi-durable-assistant-ui
```

See the [adapter installation and example](packages/adapter/README.md#install) for required peer dependencies and the minimal React integration, or [run the local demo](#try-the-demo).

- **One thread, one conversation.** Pi owns the identifiers, history, submissions, and execution. Assistant UI renders them.
- **Keep running after disconnect.** Close the browser while the agent works, then reconnect to its current state. Multiple browsers can watch the same conversation.
- **Exercise native Pi features.** Stream text and tool results, upload files, edit and fork conversations, steer work, and respond to durable human-input requests.
- **Bring your own host and UI.** Use the adapter with Assistant UI components and a `PiDurableClient` implementation. The adapter has no dependency on the demo server.

## Use the adapter

Connect your Pi Durable host to Assistant UI, then render your Assistant UI components inside the provider:

```tsx
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  createHttpPiDurableClient,
  usePiDurableRuntime,
} from "@usecontextlayer/pi-durable-assistant-ui";
import type { ReactNode } from "react";

const client = createHttpPiDurableClient({ baseUrl: "/api" });

export function PiChat({ children }: { children: ReactNode }) {
  const runtime = usePiDurableRuntime({ client });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
```

`/api` must serve the adapter's Pi HTTP/SSE protocol; installing the package does not create those routes. Your application supplies the Pi host and UI components. See the [adapter README](packages/adapter/README.md#host-contract-and-observation) for the host contract. The hook handles conversation state, streaming, history and thread navigation through Assistant UI's runtimes.

The [demo UI](apps/demo/src/App.tsx) composes Assistant UI primitives with Pi controls, tool renderers, and task inspection. Those components and the [local Node host](apps/demo/server/local-client.ts) are demo source, separate from the adapter package.

## Try the demo

Requires Node 22.19 or newer and pnpm 11.22.0:

```sh
git clone https://github.com/usecontextlayer/pi-durable-assistant-ui.git
cd pi-durable-assistant-ui
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:5173 and send `/tool` to run a local shell tool. The default provider streams deterministic responses without credentials and executes real native tools. Send `/long` to watch a longer response or `/error` to see a provider failure.

Conversations persist in `.data/pi.sqlite`; file and shell tools use `.data/workspace`. The local server can execute shell commands on your machine, so keep its configured loopback binding.

For model conversations, add `ANTHROPIC_API_KEY` to the ignored root `.env.local`, then run:

```sh
PI_PROVIDER=anthropic PI_MODEL=claude-haiku-5-5 pnpm dev
```

The demo registers Haiku models only. Keys stay on the server. See [Developing](DEVELOPING.md) for configuration, deterministic scenarios, and verification commands.

## How it works

The host exposes native Pi operations and a conversation watch. The HTTP client receives an initial view followed by Chord updates; Pi's `ConversationTranscript` handles earlier history and reconnect gaps. The adapter projects that state into Assistant UI without persisting another transcript. Native forks appear as separate conversations.

Messages, execution and metadata update in each browser's selected conversation. Switching threads releases observation while Pi keeps executing; returning catches up from native history. The sidebar lists newest-created conversations first, and external title changes or new conversations appear after explicit directory refresh. Text can steer or queue during a run; attached messages wait until the run finishes. Delete and archive explicitly reject because Pi Durable has no native operation for either. See [feature coverage](FEATURES.md) for verified behavior and the exact support boundaries.
