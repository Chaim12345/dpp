import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, readdir } from "node:fs/promises";
import { Type, type Tool } from "@mariozechner/pi-ai";
import { summarizeToolOutput } from "./context-compact.js";

const execAsync = promisify(exec);

export const toolDefs: Tool[] = [
  {
    name: "read",
    description: "Read one or more UTF-8 text files from disk. Pass a single 'path' for one file, or 'paths' array for batch reading multiple files at once. Supports offset/limit for large files.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to a single file to read" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Array of file paths to read in batch" })),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read per file" })),
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

async function readSingleFile(filePath: string, offset?: number, limit?: number): Promise<string> {
  const text = await readFile(filePath, "utf8");
  let lines = text.split("\n");
  const totalLines = lines.length;
  const startOffset = offset ? Math.max(0, Number(offset) - 1) : 0;
  const lineLimit = limit ? Number(limit) : undefined;

  if (startOffset > 0 || lineLimit !== undefined) {
    lines = lines.slice(startOffset, lineLimit !== undefined ? startOffset + lineLimit : undefined);
  }

  const output = lines.join("\n");
  const truncated = startOffset > 0 || (lineLimit !== undefined && startOffset + lineLimit < totalLines);
  const header = truncated ? `[Lines ${startOffset + 1}-${startOffset + lines.length} of ${totalLines}]` : `[${totalLines} lines]`;
  return `${header}\n${output}`;
}

export async function executeTool(name: string, args: any): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === "read") {
      // Batch read mode: paths array
      if (args.paths && Array.isArray(args.paths) && args.paths.length > 0) {
        const paths: string[] = args.paths;
        const offset = args.offset;
        const limit = args.limit;

        const results = await Promise.allSettled(
          paths.map(async (p) => {
            try {
              const content = await readSingleFile(String(p), offset, limit);
              return { path: p, content, error: null };
            } catch (err) {
              return { path: p, content: null, error: err instanceof Error ? err.message : String(err) };
            }
          })
        );

        const sections: string[] = [];
        let successCount = 0;
        let errorCount = 0;

        for (const result of results) {
          if (result.status === "fulfilled") {
            const { path, content, error } = result.value;
            if (error) {
              errorCount++;
              sections.push(`── ${path} (ERROR) ──\n${error}`);
            } else {
              successCount++;
              sections.push(`── ${path} ──\n${content}`);
            }
          } else {
            errorCount++;
            sections.push(`── (ERROR) ──\n${result.reason}`);
          }
        }

        const summary = `Batch read complete: ${successCount} succeeded, ${errorCount} failed\n\n`;
        const output = summary + sections.join("\n\n");
        return { content: summarizeToolOutput(output), isError: errorCount > 0 && successCount === 0 };
      }

      // Single file mode
      if (!args.path || typeof args.path !== "string") {
        return { content: "Missing 'path' (string) or 'paths' (array) argument", isError: true };
      }

      const output = await readSingleFile(String(args.path), args.offset, args.limit);
      return { content: summarizeToolOutput(output), isError: false };
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
