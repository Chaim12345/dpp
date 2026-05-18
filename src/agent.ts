#!/usr/bin/env bun
import { runAgentLoop } from "./agent-loop.js";

const args = process.argv.slice(2);
let prompt = "";
let thinkingEnabled = false;
let modelType = "expert";
let maxRounds = 25;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--thinking" || args[i] === "-t") {
    thinkingEnabled = true;
  } else if (args[i] === "--model" && i + 1 < args.length) {
    modelType = args[++i];
  } else if (args[i] === "--max-rounds" && i + 1 < args.length) {
    maxRounds = parseInt(args[++i], 10);
  } else {
    prompt += (prompt ? " " : "") + args[i];
  }
}

if (!prompt) {
  console.error("Usage: bun run src/agent.ts [options] '<prompt>'");
  console.error("Options:");
  console.error("  --thinking, -t          Enable thinking mode");
  console.error("  --model <type>          Model type (default: expert)");
  console.error("  --max-rounds <n>        Max tool loop iterations (default: 25)");
  process.exit(1);
}

await runAgentLoop({ prompt, thinkingEnabled, modelType, maxRounds });
