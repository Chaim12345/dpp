import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { Type } from "@mariozechner/pi-ai";
import { summarizeToolOutput } from "./context-compact.js";
const execAsync = promisify(exec);
export const toolDefs = [
    {
        name: "read",
        description: "Read a UTF-8 text file from disk.",
        parameters: Type.Object({
            path: Type.String(),
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
export async function executeTool(name, args) {
    try {
        if (name === "read") {
            const text = await readFile(String(args.path), "utf8");
            return { content: summarizeToolOutput(text), isError: false };
        }
        if (name === "bash") {
            const result = await execAsync(String(args.command), { cwd: args.cwd || process.cwd(), maxBuffer: 1024 * 1024 });
            const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
            return { content: summarizeToolOutput(combined || "(no output)"), isError: false };
        }
        return { content: `Unknown tool: ${name}`, isError: true };
    }
    catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
}
