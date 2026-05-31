// ── Pi Interactive Mode with Custom DeepSeek Web API ──────
// Entry point that wires our DeepSeek web API stream into pi-coding-agent's
// InteractiveMode. This uses pi's prebuilt TUI components instead of our
// hand-rolled terminal-mode.ts.
//
// Our proxy hits chat.deepseek.com (NOT OpenAI-compatible), so we register
// a custom "deepseek-web" API type with registerApiProvider().

import {
  AuthStorage,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";

import { registerDeepSeekWebApi, createDeepSeekWebStreamFn } from "./deepseek-web-stream.js";
import type { HarnessState } from "./types.js";

// Our shared state instance for the session
const harnessState: HarnessState = {
  chatSessionId: null,
  parentMessageId: null,
  memorySummary: "",
  authToken: null,
  cookieHeader: null,
  deepseekApiKey: null,
};

// Define a DeepSeek model that uses our custom web API
const deepSeekWebModel: Model<Api> = {
  id: "deepseek-chat-web",
  name: "DeepSeek Chat (Web)",
  api: "deepseek-web" as Api,
  provider: "deepseek-web",
  baseUrl: "https://chat.deepseek.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.00014, output: 0.00028, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64000,
  maxTokens: 8000,
};

async function main(): Promise<void> {
  const cwd = process.cwd();
  const agentDir = getAgentDir();

  // 1. Create auth storage (reads from ~/.pi/agent/auth.json or env)
  const authStorage = AuthStorage.create(agentDir);

  // 2. Create session manager
  const sessionManager = SessionManager.create(cwd);

  // 3. Define the runtime factory that registers our provider and creates sessions
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    // 1a. Register our custom API provider with the stream function
    registerDeepSeekWebApi(harnessState);

    // 1b. Create services (this also loads the model registry)
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
    });

    // 1c. Register the deepseek-web provider with our stream function
    const streamFn = createDeepSeekWebStreamFn(harnessState);
    services.modelRegistry.registerProvider("deepseek-web", {
      name: "DeepSeek Web",
      baseUrl: "https://chat.deepseek.com",
      apiKey: "unused", // Auth handled by our stream function via web-api-client.ts
      api: "deepseek-web" as Api,
      streamSimple: streamFn,
      models: [deepSeekWebModel],
    });

    // 1d. Create the agent session with our custom model
    const sessionResult = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: deepSeekWebModel,
    });

    return {
      ...sessionResult,
      services,
      diagnostics: services.diagnostics,
    };
  };

  // 4. Create the runtime
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager,
  });

  // 5. Create and run InteractiveMode with pi's prebuilt TUI
  const interactiveMode = new InteractiveMode(runtime, {
    initialMessage: process.argv[2] ?? "What can you help me with?",
  });

  await interactiveMode.run();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
