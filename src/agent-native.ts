#!/usr/bin/env tsx
import { runAgentLoop } from "./agent-loop.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error("Usage: npx tsx src/agent-native.ts '<prompt>'");
  process.exit(1);
}

await runAgentLoop({ prompt });
