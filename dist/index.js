import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { createDeepSeekNativeStream } from "./deepseek-native-stream.js";
import { compactMessages } from "./context-compact.js";
import { executeTool, toolDefs } from "./tools.js";
const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
    console.error("Usage: bun run start -- <prompt>");
    process.exit(1);
}
const state = {
    chatSessionId: null,
    parentMessageId: null,
    memorySummary: "",
};
const tools = toolDefs.map((tool) => ({
    ...tool,
    label: tool.name,
    execute: async (_toolCallId, args) => {
        const result = await executeTool(tool.name, args);
        return {
            content: [{ type: "text", text: result.content }],
            details: { summary: result.content },
            isError: result.isError,
        };
    },
}));
const model = getModel("deepseek", "deepseek-v4-pro");
const agent = new Agent({
    initialState: {
        systemPrompt: "You are a coding agent. Use tools when needed. Keep context lean.",
        model,
        tools,
    },
    streamFn: createDeepSeekNativeStream(state),
    transformContext: compactMessages,
});
agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
    }
});
await agent.prompt(prompt);
process.stdout.write("\n");
