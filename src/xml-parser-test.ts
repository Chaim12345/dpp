#!/usr/bin/env bun
import { expect, test } from "bun:test";
import { XmlToolCallParser } from "./xml-toolcall-parser.js";

test("XmlToolCallParser parses a basic invoke", async () => {
  const parser = new XmlToolCallParser();
  await parser.init();
  parser.feed("<tool_calls><invoke name=\"bash\"><parameter name=\"command\">ls -la</parameter></invoke></tool_calls>");
  parser.end();
  expect(parser.getToolCalls()).toEqual([{ name: "bash", arguments: { command: "ls -la" } }]);
  parser.destroy();
});
