import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { Type, type Tool } from "@mariozechner/pi-ai";
import { summarizeToolOutput } from "./context-compact.js";

const execAsync = promisify(exec);

export const toolDefs: Tool[] = [
  {
    name: "read",
    description: "Read a UTF-8 text file from disk. Supports offset/limit for large files.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
  },
  {
    name: "bash",
    description: "Run a shell command and capture stdout/stderr.",
    parameters: Type.Object({
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
    }),
  },
];

export async function executeTool(name: string, args: any): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === "read") {
      const text = await readFile(String(args.path), "utf8");
      let lines = text.split("\n");
      const offset = args.offset ? Math.max(0, Number(args.offset) - 1) : 0;
      const limit = args.limit ? Number(args.limit) : undefined;
      if (offset > 0 || limit !== undefined) {
        lines = lines.slice(offset, limit !== undefined ? offset + limit : undefined);
      }
      const output = lines.join("\n");
      const truncated = offset > 0 || (limit !== undefined && offset + limit < text.split("\n").length);
      const header = truncated ? `[Lines ${offset + 1}-${offset + lines.length} of ${text.split("\n").length}]\n` : "";
      return { content: summarizeToolOutput(header + output), isError: false };
    }
    if (name === "bash") {
      const result = await execAsync(String(args.command), { cwd: args.cwd || process.cwd(), maxBuffer: 1024 * 1024 });
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return { content: summarizeToolOutput(combined || "(no output)"), isError: false };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}
