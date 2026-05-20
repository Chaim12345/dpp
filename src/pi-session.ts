// ── Pi Session Management ──────────────────────────────────────
// Wraps pi's SessionManager, AuthStorage, and SettingsManager
// for use with our DeepSeek custom API client.

import {
  AuthStorage,
  SessionManager,
  SettingsManager,
  getAgentDir,
  defineTool,
  type Tool,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { PiAgentLoop } from "./pi-agent-loop.js";

// ── Pi Session ─────────────────────────────────────────────────

export interface PiSessionOptions {
  modelType?: string;
  thinkingEnabled?: boolean;
  maxRounds?: number;
  maxContextTokens?: number;
  tools?: string[];
  customTools?: Tool[];
  persistSessions?: boolean;
}

export class PiSession {
  readonly sessionManager: SessionManager;
  readonly authStorage: AuthStorage;
  readonly settingsManager: SettingsManager;
  readonly loop: PiAgentLoop;
  readonly options: Required<PiSessionOptions>;

  private subscribers: Array<(event: any) => void | Promise<void>> = [];
  private unsubLoop?: () => void;

  constructor(options: PiSessionOptions = {}) {
    this.options = {
      modelType: options.modelType ?? "expert",
      thinkingEnabled: options.thinkingEnabled ?? false,
      maxRounds: options.maxRounds ?? 25,
      maxContextTokens: options.maxContextTokens ?? 16_000,
      tools: options.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
      customTools: options.customTools ?? [],
      persistSessions: options.persistSessions ?? false,
    };

    // Pi session management
    this.sessionManager = this.options.persistSessions
      ? SessionManager.create(process.cwd())
      : SessionManager.inMemory();

    this.authStorage = AuthStorage.create();
    this.settingsManager = SettingsManager.inMemory();

    // Apply settings
    if (this.options.thinkingEnabled) {
      this.settingsManager.setDefaultThinkingLevel("medium");
    }

    // Agent loop
    this.loop = new PiAgentLoop({
      modelType: this.options.modelType,
      thinkingEnabled: this.options.thinkingEnabled,
      maxRounds: this.options.maxRounds,
      maxContextTokens: this.options.maxContextTokens,
    });

    // Subscribe to loop events and record in session
    this.unsubLoop = this.loop.subscribe(async (event) => {
      for (const cb of this.subscribers) {
        try { await cb(event); } catch {}
      }
    });
  }

  subscribe(cb: (event: any) => void | Promise<void>): () => void {
    this.subscribers.push(cb);
    return () => {
      const idx = this.subscribers.indexOf(cb);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  async init(): Promise<void> {
    await this.loop.init();
  }

  async prompt(text: string): Promise<void> {
    // Record user message in session
    this.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    await this.loop.execute(text);

    // Record assistant response in session
    const messages = this.loop.messagesSnapshot;
    const lastAssistant = messages.filter(m => m.role === "assistant").pop();
    if (lastAssistant) {
      const text = typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : lastAssistant.content?.map((c: any) => c.type === "text" ? c.text : "").join("") || "";
      if (text) {
        this.sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        });
      }
    }
  }

  async newSession(): Promise<void> {
    await this.loop.newSession();
  }

  clearMessages(): void {
    this.loop.clearMessages();
  }

  abort(): void {
    this.loop.abort();
  }

  get messagesSnapshot() {
    return this.loop.messagesSnapshot;
  }

  get turnCount() {
    return this.loop.turnCount;
  }

  estimateTokens() {
    return this.loop.estimateCurrentTokens();
  }

  dispose(): void {
    this.unsubLoop?.();
  }
}

// ── Session Factory ────────────────────────────────────────────

export async function createPiSession(options: PiSessionOptions = {}): Promise<PiSession> {
  const session = new PiSession(options);
  await session.init();
  return session;
}

// ── Custom Tool Helper ─────────────────────────────────────────

export function createCustomTool<TSchema extends TSchema>(
  name: string,
  label: string,
  description: string,
  parameters: TSchema,
  execute: (params: Static<TSchema>) => Promise<{ content: string; isError?: boolean }>
): Tool {
  return defineTool({
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params) {
      const result = await execute(params as Static<TSchema>);
      return {
        content: [{ type: "text", text: result.content }],
        details: {},
        isError: result.isError ?? false,
      };
    },
  });
}
