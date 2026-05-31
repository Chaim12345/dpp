#!/usr/bin/env bun
import { expect, test } from "bun:test";
import { extractToolCalls, stripToolCalls } from "./tool-registry.js";

test("extracts first JSON payload from nested duplicate tool_calls wrappers", () => {
  const text = [
    '<tool_calls>[{"name":"bash","arguments":{"command":"find . -maxdepth 3 | head -200"}}]',
    '<tool_calls>[{"name":"bash","arguments":{"command":"find . -maxdepth 3 | head -200"}}]</tool_calls>',
  ].join("\n");

  const calls = extractToolCalls(text);
  expect(calls).toEqual([
    {
      name: "bash",
      arguments: { command: "find . -maxdepth 3 | head -200" },
    },
  ]);
});

test("strips malformed nested duplicate tool_calls wrappers from visible text", () => {
  const text = [
    "Let me inspect that.",
    '<tool_calls>[{"name":"bash","arguments":{"command":"ls -la"}}]',
    '<tool_calls>[{"name":"bash","arguments":{"command":"ls -la"}}]</tool_calls>',
  ].join("\n");

  expect(stripToolCalls(text)).toBe("Let me inspect that.");
});
