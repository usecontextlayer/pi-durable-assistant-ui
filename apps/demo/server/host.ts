import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
  type AgentChange,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createDemoProvider } from "../scenarios/faux-provider.js";
import { DemoTools } from "../scenarios/tools.js";
import { BackgroundTools } from "../scenarios/background.js";
import { createExecutionEnvironments, prepareLocalPaths, type LocalPaths } from "./env.js";
import { humanInputExtension } from "./interaction.js";
import { initializeConversationMetadata } from "./metadata.js";

export interface OpenLocalPiHostOptions {
  dataDirectory: string;
  provider?: "faux" | "anthropic";
  modelId?: string;
  tokensPerSecond?: number;
  enableAnthropic?: boolean;
  response?: FauxResponseFactory;
  settings?: HarnessOptions["settings"];
}

export async function openLocalPiHost(options: OpenLocalPiHostOptions) {
  const paths = await prepareLocalPaths(options.dataDirectory);
  const models = createModels();
  const { provider: demoProvider, faux } = createDemoProvider({ tokensPerSecond: options.tokensPerSecond, response: options.response });
  models.setProvider(demoProvider);
  if (options.provider === "anthropic" || options.enableAnthropic) {
    const anthropic = anthropicProvider();
    const haikuModels = anthropic.getModels().filter((model) => model.id.includes("haiku"));
    models.setProvider({ ...anthropic, getModels: () => haikuModels, getAllModels: () => haikuModels });
  }

  const selectedModel = options.modelId ?? (options.provider === "anthropic" ? "claude-haiku-5-5" : "demo");
  if (options.provider === "anthropic" && !models.getModel("anthropic", selectedModel)) {
    throw new Error(`The demo only permits registered Haiku models; unknown selection: ${selectedModel}`);
  }

  const defaultAgent: AgentChange = {
    model: {
      provider: options.provider ?? "faux",
      modelId: selectedModel,
    },
    cwd: paths.workspacePath,
  };
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(DemoTools);
  registry.install(BackgroundTools);
  registry.install(humanInputExtension);
  registry.install(defineExtension({
    name: "demo",
    sections: [section("preamble", () => "You are a helpful assistant in a local Pi Durable demonstration. Use the tools when useful. Explain results clearly.", { tag: false })],
  }));

  const environments = createExecutionEnvironments(paths);
  const harness = await Harness.open(await openNodeSqliteStorage(paths.databasePath), {
    models,
    registry,
    env: ({ cwd }) => environments.get(cwd),
    settings: options.settings ?? { toolExecution: "parallel" },
    conversationCreated: initializeConversationMetadata,
  }, BACKGROUND_CONTEXT);
  harness.resume();

  return {
    harness,
    models,
    registry,
    faux,
    defaultAgent,
    paths,
    async close() {
      await harness.close(BACKGROUND_CONTEXT);
      await environments.close();
    },
  };
}

export type LocalPiHost = Awaited<ReturnType<typeof openLocalPiHost>>;
export type { LocalPaths };
