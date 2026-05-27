export type NativeStreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "done"; response_message_id: number | null }
  | { type: "error"; error: string };

// ── Stop reason enum (replaces fragile string literals) ──
export const StopReason = {
  ToolUse: "toolUse",
  Stop: "stop",
  Error: "error",
  AuthExpired: "auth_expired",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

export interface HarnessState {
  chatSessionId: string | null;
  parentMessageId: number | null;
  memorySummary: string;
  authToken: string | null;
  cookieHeader: string | null;
  deepseekApiKey: string | null;
}
