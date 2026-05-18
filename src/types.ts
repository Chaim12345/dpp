export type NativeStreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "done"; response_message_id: number | null }
  | { type: "error"; error: string };

export interface HarnessState {
  chatSessionId: string | null;
  parentMessageId: number | null;
  memorySummary: string;
  authToken: string | null;
  cookieHeader: string | null;
}
