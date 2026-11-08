# Developing

## Run locally

Requires Node 22.19 or newer and pnpm 11.22.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the URL printed by the server, normally http://127.0.0.1:5173. Vite and the native API share one local origin. The adapter compiler, Vite frontend, and native server watch their source files during development.

Conversations persist in `.data/pi.sqlite`; native file and shell tools use `.data/workspace`. The browser's `?conversation=` query selects a native conversation. Reloading or closing the browser releases observation while the agent continues running.

On opening an existing database, the demo initializes missing metadata documents before resuming tasks. Supported title, feedback and suggestion values from the earlier `demo.presentation` document are copied into `demo.metadata`, and copied legacy documents are retired. Existing current metadata takes precedence. New conversations and forks initialize metadata through Pi's native creation hook.

The local host exposes native execution capabilities, including file and shell tools. Keep it bound to loopback as configured.

## Providers and configuration

The default deterministic provider requires no API key. Ordinary messages stream a repeatable response. Its scenarios exercise the real harness, SQLite storage, and native tools; they are not model intelligence.

For a real provider, put `ANTHROPIC_API_KEY` in the ignored root `.env.local` or supply it to the server process:

```sh
PI_PROVIDER=anthropic PI_MODEL=claude-haiku-5-5 pnpm dev
```

Keys remain in the server process. Haiku is the only real-model family registered by the demo.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_PROVIDER` | Select `faux` or `anthropic` for new conversations. | `faux` |
| `PI_MODEL` | Select a registered model for new conversations. | `demo` for faux; `claude-haiku-5-5` for Anthropic |
| `ANTHROPIC_API_KEY` | Enable the Anthropic provider and its Haiku catalog. | Unset |
| `PI_DATA_DIRECTORY` | Directory containing the SQLite database and tool workspace. | `.data` at the repository root |
| `PORT` | Local HTTP port; `0` selects an available port. | `5173` |

The demo installs instruction sections through registered renderers. Replacing a registered implementation affects subsequent preparation of existing conversations. Changing creation defaults does not rewrite their stored model or configuration selections.

## Deterministic scenarios

Select `faux/demo` in a dedicated conversation to run these while keeping ordinary conversations on Haiku.

Start with `/tool` for Pi's local bash tool, `/long` for a longer streamed response, or `/error` for a provider failure. The provider also exposes `/slow`, `/files`, `/parallel`, `/nested`, `/progress`, `/image`, `/subagent`, `/background`, `/handoff`, `/approval`, `/limit`, `/instructions`, and `/read <path>`. These execute native runtime paths and local tools.

## Verify changes

```sh
pnpm check
pnpm build
pnpm test
PLAYWRIGHT_SKIP_BROWSER_GC=1 pnpm exec playwright install chromium
pnpm test:e2e
```

Tests own temporary SQLite databases, workspaces, and ephemeral listening ports. They never use `.data`. Node's experimental EventSource is enabled for tests to exercise the browser client's streaming implementation. Browser installation disables Playwright's shared-cache garbage collection.

Delete and archive are unsupported native operations and raise explicitly; they are not simulated through metadata.

See [feature coverage](FEATURES.md) for the tested behaviors, evidence sources, and remaining limitations.

## Package boundary

The [adapter README](packages/adapter/README.md) owns the consumer integration contract. `apps/demo/server/local-client.ts` binds native Pi operations for both direct consumers and HTTP routes. HTTP owns browser request admission, parsing, serialization, and multiplexed SSE delivery over one connection per client; `apps/demo/src` composes Assistant UI primitives and the demo's Pi-specific controls.

`SerializedAgentChange` represents selected tools, extensions, and model tools by registered names. The host resolves those names against Pi's registry before calling native `configure`; it does not serialize functions or store another configuration record. Omitted fields remain unchanged and `null` clears a field. Inspect the current native configuration through Conversation controls.

## Releases

Every push to `main` runs type checks, the build, native/unit tests and Chromium workflows in GitHub Actions. After those pass, semantic-release analyzes Conventional Commits and publishes `packages/adapter` to npm when a release is due. `fix` produces a patch, `feat` a minor, and `!` or a `BREAKING CHANGE` footer a major. Commits that do not call for a release still run verification.

The adapter's `0.0.0-development` manifest version is a placeholder. Semantic-release owns published versions, Git tags and GitHub Release notes; it does not commit a version bump back to the repository. The private workspace and demo are not published.

The workflow uses the repository's `NPM_TOKEN` secret and the built-in `GITHUB_TOKEN`. The npm token must have permission to create and publish packages in the `@usecontextlayer` scope. Authentication uses the token without OIDC; configure an npm trusted publisher before changing that. `mise.toml` supplies the CI toolchain, with its pnpm pin matching the root `packageManager` field. Release results and notes are available in [GitHub Actions](https://github.com/usecontextlayer/pi-durable-assistant-ui/actions/workflows/release.yml) and [GitHub Releases](https://github.com/usecontextlayer/pi-durable-assistant-ui/releases).
