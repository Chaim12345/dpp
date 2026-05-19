import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { createDeepSeekNativeStream } from "./deepseek-native-stream.js";
import { compactMessages } from "./context-compact.js";
import { executeTool, toolDefs } from "./tools.js";
import type { HarnessState } from "./types.js";
import * as readline from "node:readline";

const state: HarnessState = {
  chatSessionId: null,
  parentMessageId: null,
  memorySummary: "",
  authToken: null,
  cookieHeader: null,
};

const tools: AgentTool[] = toolDefs.map((tool) => ({
  ...tool,
  label: tool.name,
  execute: async (_toolCallId: string, args: any) => {
    const result = await executeTool(tool.name, args);
    return {
      content: [{ type: "text", text: result.content }],
      details: { summary: result.content },
      isError: result.isError,
    };
  },
}));

const model = getModel("deepseek", "deepseek-v4-pro");

function createAgent(): Agent {
  state.chatSessionId = null;
  state.parentMessageId = null;
  return new Agent({
    initialState: {
      systemPrompt: "You are a coding agent with file system and shell access. Use tools when needed. Keep responses concise.",
      model,
      tools,
    },
    streamFn: createDeepSeekNativeStream(state),
    transformContext: compactMessages,
  });
}

async function runOneShot(prompt: string): Promise<void> {
  const agent = createAgent();
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await agent.prompt(prompt);
  process.stdout.write("\n");
}

async function runRepl(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36mπ\x1b[0m> ",
  });

  let agent = createAgent();
  let turnCount = 0;

  function subscribeAgent(a: Agent) {
    a.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });
  }
  subscribeAgent(agent);

  console.log("\x1b[1mDeepSeek Pi-Harness CLI\x1b[0m");
  console.log("\x1b[90mType a message, or /help for commands. Ctrl+C to exit.\x1b[0m\n");
  rl.prompt();

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    // Commands
    if (trimmed.startsWith("/")) {
      const parts = trimmed.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      switch (cmd) {
        case "help": case "h": case "?":
          console.log("\x1b[90mCommands:");
          console.log("  /clear    - Clear conversation (new session)");
          console.log("  /new      - Create new session");
          console.log("  /session  - Show session info");
          console.log("  /quit     - Exit");
          console.log("  /help     - Show this help\x1b[0m");
          break;
        case "clear": case "cls":
          agent = createAgent();
          subscribeAgent(agent);
          turnCount = 0;
          console.log("\x1b[90mConversation cleared.\x1b[0m");
          break;
        case "new":
          agent = createAgent();
          subscribeAgent(agent);
          turnCount = 0;
          console.log("\x1b[90mNew session created.\x1b[0m");
          break;
        case "session": case "info":
          console.log(`\x1b[90mTurns: ${turnCount} | Session: ${state.chatSessionId ?? "none"}\x1b[0m`);
          break;
        case "quit": case "exit": case "q":
          console.log("\x1b[90mBye!\x1b[0m");
          rl.close();
          process.exit(0);
          break;
        default:
          console.log(`\x1b[33mUnknown command: /${cmd}. Type /help for options.\x1b[0m`);
      }
      rl.prompt();
      return;
    }

    // Send message to agent
    try {
      turnCount++;
      await agent.prompt(trimmed);
      process.stdout.write("\n");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31mError: ${msg}\x1b[0m`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\n\x1b[90mBye!\x1b[0m");
    process.exit(0);
  });
}

// Main
const args = process.argv.slice(2).join(" ").trim();
if (args) {
  await runOneShot(args);
} else {
  await runRepl();
}
