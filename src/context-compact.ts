import type { AgentMessage } from "@mariozechner/pi-agent-core";

const MAX_TEXT = 4000;

function compactText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  const head = text.slice(0, 2000);
  const tail = text.slice(-1200);
  return `${head}\n\n[... ${text.length - 3200} chars omitted ...]\n\n${tail}`;
}

export async function compactMessages(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const start = Math.max(0, messages.length - 8);
  return messages.slice(start).map((message) => {
    if (message.role === "toolResult") {
      return {
        ...message,
        content: message.content.map((item) =>
          item.type === "text" ? { ...item, text: compactText(item.text) } : item,
        ),
      };
    }
    if (message.role === "user" && typeof message.content === "string") {
      return { ...message, content: compactText(message.content) };
    }
    return message;
  });
}

export function summarizeToolOutput(text: string): string {
  return compactText(text);
}
