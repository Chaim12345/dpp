import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { createParser } from "vectorjson";
import { XmlToolCallParser } from "./xml-toolcall-parser.js";

const DEEPSEEK_URL = "https://chat.deepseek.com";

export class RetryableError extends Error {
  constructor(message?: string) {
    super(message ?? "Retryable error");
    this.name = "RetryableError";
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; baseDelayMs?: number; onRetry?: (attempt: number, err: Error) => void },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const onRetry = options?.onRetry;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr instanceof StaleAuthError || lastErr instanceof WafTokenExpiredError) throw lastErr;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        if (onRetry) onRetry(attempt, lastErr);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr ?? new Error("Retry failed");
}

export class StaleAuthError extends Error {
  constructor(message?: string) {
    super(message ?? "Authentication token has expired or is invalid");
    this.name = "StaleAuthError";
  }
}

export class WafTokenExpiredError extends Error {
  constructor(message?: string) {
    super(message ?? "CDN-level WAF token has expired (403 detected)");
    this.name = "WafTokenExpiredError";
  }
}

export interface AuthResult {
  token: string | null;
  cookieHeader: string | null;
}

export interface ChatStreamOptions {
  sessionId: string;
  prompt: string;
  parentMessageId: number | null;
  modelType: string;
  thinkingEnabled?: boolean;
  signal?: AbortSignal;
}

export interface LoadAuthOptions {
  token?: string;
  tokenPath?: string;
  authPath?: string;
}

interface ChromeAuthOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

interface ChromeAuthJson {
  origins?: ChromeAuthOrigin[];
  token?: string;
  cookie_header?: string;
}

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://127.0.0.1:8191";

const DEFAULT_CWD = process.cwd();

function defaultTokenPath(cwd: string): string {
  return path.join(cwd, ".pi", "agent", "deepseek_token.txt");
}

function defaultAuthPath(cwd: string): string {
  return path.join(cwd, ".pi", "agent", "deepseek_auth.json");
}

async function tryReadCookies(
  authPath: string
): Promise<string | null> {
  try {
    await access(authPath);
    const raw = await readFile(authPath, "utf-8");
    const json: ChromeAuthJson = JSON.parse(raw);
    return json.cookie_header ?? null;
  } catch {
    return null;
  }
}

export async function loadAuth(options?: LoadAuthOptions): Promise<AuthResult> {
  const cwd = DEFAULT_CWD;
  const tokenPath = options?.tokenPath ?? process.env.DEEPSEEK_TOKEN_STATE ?? defaultTokenPath(cwd);
  const authPath = options?.authPath ?? process.env.DEEPSEEK_AUTH_STATE ?? defaultAuthPath(cwd);

  let token: string | null = options?.token ?? process.env.DEEPSEEK_TOKEN ?? null;

  if (!token) {
    try {
      await access(tokenPath);
      const contents = await readFile(tokenPath, "utf-8");
      token = contents.trim() || null;
    } catch {
    }
  }

  if (!token) {
    try {
      await access(authPath);
      const raw = await readFile(authPath, "utf-8");
      const json: ChromeAuthJson = JSON.parse(raw);

      token = json.token ?? null;

      if (!token) {
        const origins = json.origins ?? [];
        for (const origin of origins) {
          if (!origin.origin?.includes("chat.deepseek.com")) continue;
          for (const entry of origin.localStorage ?? []) {
            if (entry.name !== "userToken") continue;
            try {
              const parsed = JSON.parse(entry.value);
              token = parsed.value ?? entry.value;
            } catch {
              token = entry.value;
            }
            if (token) break;
          }
          if (token) break;
        }
      }
    } catch {
    }
  }

  const cookieHeader = await tryReadCookies(authPath);
  return { token, cookieHeader };
}

export async function persistToken(token: string): Promise<void> {
  const cwd = DEFAULT_CWD;
  const agentDir = path.join(cwd, ".pi", "agent");
  const tokenPath = path.join(agentDir, "deepseek_token.txt");
  const authPath = path.join(agentDir, "deepseek_auth.json");

  await mkdir(agentDir, { recursive: true });
  await writeFile(tokenPath, token + "\n", "utf-8");

  let state: ChromeAuthJson = {};
  try {
    await access(authPath);
    const raw = await readFile(authPath, "utf-8");
    state = JSON.parse(raw);
  } catch {
    state = { origins: [] };
  }

  const origins: ChromeAuthOrigin[] = state.origins ?? [];
  let origin = origins.find((o) => o.origin === "https://chat.deepseek.com");
  if (!origin) {
    origin = { origin: "https://chat.deepseek.com", localStorage: [] };
    origins.push(origin);
  }

  const ls = origin.localStorage;
  const tokenValue = JSON.stringify({ value: token, __version: "0" });
  const existing = ls.find((e) => e.name === "userToken");
  if (existing) {
    existing.value = tokenValue;
  } else {
    ls.push({ name: "userToken", value: tokenValue });
  }

  state.token = token;
  state.origins = origins;

  await writeFile(authPath, JSON.stringify(state, null, 2), "utf-8");
}

export async function persistCookies(cookieHeader: string): Promise<void> {
  const cwd = DEFAULT_CWD;
  const authPath = defaultAuthPath(cwd);
  let state: ChromeAuthJson = {};
  try {
    await access(authPath);
    state = JSON.parse(await readFile(authPath, "utf-8"));
  } catch {
    state = {};
  }
  state.cookie_header = cookieHeader;
  await writeFile(authPath, JSON.stringify(state, null, 2), "utf-8");
}

interface FlareSolverrCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

interface FlareSolverrResponse {
  solution?: {
    url?: string;
    status?: number;
    cookies?: FlareSolverrCookie[];
    headers?: Record<string, string>;
    response?: string;
  };
  status?: string;
  message?: string;
}

export async function refreshWafToken(
  currentCookieHeader: string | null
): Promise<{ cookieHeader: string | null }> {
  const flareUrl = FLARESOLVERR_URL;

  try {
    const payload = {
      cmd: "request.get",
      url: `${DEEPSEEK_URL}/`,
      maxTimeout: 120000,
      sessionWindowTtl: 7200,
      clearSession: true,
    };
    const resp = await fetch(`${flareUrl}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(130_000),
    });

    if (!resp.ok) {
      throw new Error(`FlareSolverr returned HTTP ${resp.status}`);
    }

    const data: FlareSolverrResponse = await resp.json();
    const cookies = data?.solution?.cookies ?? [];

    const wafToken = cookies.find((c) => c.name === "aws-waf-token")?.value ?? null;
    const dsSession = cookies.find((c) => c.name === "ds_session_id")?.value ?? null;
    const smidV2 = cookies.find((c) => c.name === "smidV2")?.value ?? null;
    const thumbCookie = cookies.find((c) => c.name?.startsWith(".thumbcache")) ?? null;

    if (!wafToken) {
      throw new Error(
        `FlareSolverr returned no aws-waf-token. Available cookies: ${cookies.map((c) => c.name).join(", ")}`
      );
    }

    const parts: string[] = [`aws-waf-token=${wafToken}`];
    if (dsSession) parts.push(`ds_session_id=${dsSession}`);
    if (smidV2) parts.push(`smidV2=${smidV2}`);
    if (thumbCookie) parts.push(`${thumbCookie.name}=${thumbCookie.value}`);

    const newCookieHeader = parts.join("; ");

    await persistCookies(newCookieHeader);
    return { cookieHeader: newCookieHeader };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
      throw new WafTokenExpiredError(
        `WAF token expired but FlareSolverr not available at ${flareUrl}. ` +
        `Install FlareSolverr or re-export auth state from browser.`
      );
    }
    throw new WafTokenExpiredError(
      `WAF token refresh failed: ${message}`
    );
  }
}

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path?: string;
}

export class DeepSeekPoWSolver {
  private instance: WebAssembly.Instance | null = null;
  private exports: any = null;
  private memory: WebAssembly.Memory | null = null;

  async init(): Promise<void> {
    const wasmPath = path.join(process.cwd(), "sha3_wasm_bg.wasm");
    try {
      await access(wasmPath);
    } catch {
      throw new Error(
        `PoW WASM file not found at ${wasmPath}. Ensure sha3_wasm_bg.wasm exists at project root.`
      );
    }
    const bytes = await readFile(wasmPath);
    const result = await WebAssembly.instantiate(bytes, {});
    this.instance = result.instance;
    this.exports = result.instance.exports;
    this.memory = this.exports.memory as WebAssembly.Memory;
  }

  async solveChallenge(challenge: PowChallenge | null): Promise<string | null> {
    if (!challenge || challenge.algorithm !== "DeepSeekHashV1") return null;

    if (!this.exports) await this.init();

    const exp = this.exports;

    const retptr = exp.__wbindgen_add_to_stack_pointer(-16);

    try {
      const challengeStr = challenge.challenge;
      const prefixStr = `${challenge.salt}_${challenge.expire_at}_`;

      const enc = new TextEncoder();
      const challengeBytes = enc.encode(challengeStr);
      const prefixBytes = enc.encode(prefixStr);

      const challengePtr = exp.__wbindgen_export_0(challengeBytes.length, 1);
      const prefixPtr = exp.__wbindgen_export_0(prefixBytes.length, 1);

      const mem = new Uint8Array(this.memory!.buffer);
      mem.set(challengeBytes, challengePtr);
      mem.set(prefixBytes, prefixPtr);

      const difficulty = challenge.difficulty;
      exp.wasm_solve(retptr, challengePtr, challengeBytes.length, prefixPtr, prefixBytes.length, difficulty);

      const i32 = new Int32Array(this.memory!.buffer);
      const status = i32[retptr / 4];

      if (status === 0) {
        throw new Error("PoW solver returned no solution for the given challenge");
      }

      const f64 = new Float64Array(this.memory!.buffer);
      const answerFloat = f64[(retptr + 8) / 8];
      const answer = Math.round(answerFloat);

      const resultObj: Record<string, unknown> = {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
      };
      if (challenge.target_path) {
        resultObj.target_path = challenge.target_path;
      }

      return Buffer.from(JSON.stringify(resultObj)).toString("base64");
    } finally {
      exp.__wbindgen_add_to_stack_pointer(16);
    }
  }
}

function buildBaseHeaders(token: string | null, cookieHeader: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "*/*",
    "Content-Type": "application/json",
    Origin: DEEPSEEK_URL,
    Referer: `${DEEPSEEK_URL}/`,
    "x-app-version": "20241129.1",
    "x-client-locale": "en_US",
    "x-client-platform": "web",
    "x-client-timezone-offset": "10800",
    "x-client-version": "2.0.0",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    priority: "u=1, i",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

export function parseSessionCreateResponse(json: any): string {
  const sessionId =
    json?.data?.biz_data?.chat_session?.id ??
    json?.data?.biz_data?.id ??
    null;
  if (!sessionId) {
    throw new Error(
      `Failed to parse session ID from response: ${JSON.stringify(json).slice(0, 300)}`
    );
  }
  return sessionId;
}

export async function createSession(
  token: string,
  cookieHeader: string | null,
  modelType = "default"
): Promise<string> {
  const headers = buildBaseHeaders(token, cookieHeader);
  const resp = await fetch(`${DEEPSEEK_URL}/api/v0/chat_session/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: "chat", model_type: modelType }),
  });

  if (resp.status === 401 || resp.status === 403) {
    if (
      resp.status === 403 &&
      resp.headers.get("x-amzn-waf-action")
    ) {
      throw new WafTokenExpiredError(
        `WAF token expired (403 with x-amzn-waf-action header). Re-export auth state from browser.`
      );
    }
    throw new StaleAuthError(
      `Authentication failed (HTTP ${resp.status}) during session creation`
    );
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Session creation failed (HTTP ${resp.status}): ${text.slice(0, 500)}`
    );
  }

  const json = await resp.json();
  return parseSessionCreateResponse(json);
}

export async function ensureSession(
  state: {
    chatSessionId: string | null;
    authToken: string | null;
    cookieHeader: string | null;
  },
  modelType = "default"
): Promise<string> {
  if (state.chatSessionId) return state.chatSessionId;

  const auth =
    state.authToken
      ? { token: state.authToken, cookieHeader: state.cookieHeader }
      : await loadAuth();

  if (!auth.token) {
    throw new Error(
      "No DeepSeek auth token available. Run the proxy first to set up auth, or set DEEPSEEK_TOKEN env var."
    );
  }

  state.authToken ??= auth.token;
  state.cookieHeader ??= auth.cookieHeader;

  try {
    const sessionId = await createSession(auth.token, auth.cookieHeader, modelType);
    state.chatSessionId = sessionId;
    return sessionId;
  } catch (err) {
    if (err instanceof WafTokenExpiredError) {
      try {
        const refreshed = await refreshWafToken(auth.cookieHeader);
        state.cookieHeader = refreshed.cookieHeader;
        const sessionId = await createSession(auth.token, refreshed.cookieHeader, modelType);
        state.chatSessionId = sessionId;
        return sessionId;
      } catch {
        throw err;
      }
    }
    if (err instanceof StaleAuthError) {
      const refreshed = await loadAuth();
      if (!refreshed.token) throw new Error("Re-auth failed: no token available after refresh");

      state.authToken = refreshed.token;
      state.cookieHeader = refreshed.cookieHeader;

      const sessionId = await createSession(refreshed.token, refreshed.cookieHeader, modelType);
      state.chatSessionId = sessionId;
      return sessionId;
    }
    throw err;
  }
}

async function withWafRetry<T>(
  fn: (cookieHeader: string | null) => Promise<T>,
  stateCookieRef: { cookieHeader: string | null }
): Promise<T> {
  try {
    return await fn(stateCookieRef.cookieHeader);
  } catch (err) {
    if (err instanceof WafTokenExpiredError) {
      const refreshed = await refreshWafToken(stateCookieRef.cookieHeader);
      stateCookieRef.cookieHeader = refreshed.cookieHeader;
      return await fn(refreshed.cookieHeader);
    }
    throw err;
  }
}

export async function chatStream(
  options: ChatStreamOptions,
  state: {
    authToken: string | null;
    cookieHeader: string | null;
    powSolver: DeepSeekPoWSolver | null;
  }
): Promise<Response> {
  const auth =
    state.authToken
      ? { token: state.authToken, cookieHeader: state.cookieHeader }
      : await loadAuth();

  if (!auth.token) {
    throw new Error("No DeepSeek auth token available");
  }

  state.authToken ??= auth.token;
  state.cookieHeader ??= auth.cookieHeader;

  if (!state.powSolver) {
    const solver = new DeepSeekPoWSolver();
    await solver.init();
    state.powSolver = solver;
  }

  const powChallengeResp = await fetch(
    `${DEEPSEEK_URL}/api/v0/chat/create_pow_challenge`,
    {
      method: "POST",
      headers: buildBaseHeaders(auth.token, auth.cookieHeader),
      body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
    }
  );

  let powHeader: string | null = null;
  if (powChallengeResp.ok) {
    const challengeJson = await powChallengeResp.json();
    const challenge = challengeJson?.data?.biz_data?.challenge as PowChallenge | undefined;
    powHeader = await state.powSolver.solveChallenge(challenge ?? null);
  }

  const now = new Date();
  const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const clientStreamId = `${yyyymmdd}-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  const payload: Record<string, unknown> = {
    chat_session_id: options.sessionId,
    prompt: options.prompt,
    model_type: options.modelType,
    ref_file_ids: [],
    thinking_enabled: options.thinkingEnabled ?? false,
    search_enabled: false,
    preempt: false,
    client_stream_id: clientStreamId,
  };
  if (options.parentMessageId != null) {
    payload.parent_message_id = options.parentMessageId;
  }

  const headers: Record<string, string> = {
    ...buildBaseHeaders(auth.token, auth.cookieHeader),
    "x-client-stream-id": clientStreamId,
  };
  if (powHeader) {
    headers["x-ds-pow-response"] = powHeader;
  }

  return await withWafRetry(async (currentCookieHeader) => {
    const h: Record<string, string> = {
      ...buildBaseHeaders(auth.token, currentCookieHeader ?? auth.cookieHeader),
      "x-client-stream-id": clientStreamId,
    };
    if (powHeader) h["x-ds-pow-response"] = powHeader;

    const resp = await fetch(`${DEEPSEEK_URL}/api/v0/chat/completion`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    if (resp.status === 401 || resp.status === 403) {
      if (resp.status === 403 && resp.headers.get("x-amzn-waf-action")) {
        throw new WafTokenExpiredError(
          `WAF token expired (403 with x-amzn-waf-action).`
        );
      }
      throw new StaleAuthError(
        `Authentication failed (HTTP ${resp.status}) during chat stream`
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Chat stream failed (HTTP ${resp.status}): ${text.slice(0, 500)}`);
    }

    return resp;
  }, state);
}

export type DeepSeekSseEvent =
  | { type: "content"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_calls"; calls: Array<{ name: string; arguments: Record<string, unknown> }> }
  | { type: "done"; responseMessageId: number | null }
  | { type: "error" };

// V4 SSE uses fragments: THINK and RESPONSE both stream to /content path.
// We track the last fragment type to route content vs thinking deltas correctly.
interface SseParseState {
  lastFragmentType: string | null;
  responseMessageId: number | null;
}

export function parseSseLine(
  dataStr: string,
  state?: SseParseState,
): DeepSeekSseEvent | DeepSeekSseEvent[] | null {
  if (dataStr === "[DONE]") return { type: "done", responseMessageId: null };

  let data: any;
  try {
    data = JSON.parse(dataStr);
  } catch {
    return null;
  }

  if (!data || typeof data !== "object") return null;

  // Track response_message_id from any data line
  if (data.response_message_id != null) {
    if (state) state.responseMessageId = Number(data.response_message_id);
  }

  // Fragment setup: {"v":{"response":{"fragments":[...]}}}
  // This tells us what type of fragment is being created
  if (data.v && typeof data.v === "object" && data.v.response?.fragments) {
    const fragments: Array<{ type: string; content?: string }> =
      data.v.response.fragments;
    const events: DeepSeekSseEvent[] = [];
    for (const frag of fragments) {
      if (frag.type === "THINK" && frag.content) {
        events.push({ type: "thinking", delta: frag.content });
        if (state) state.lastFragmentType = "THINK";
      } else if (
        (frag.type === "TEXT" || frag.type === "text" || frag.type === "RESPONSE") &&
        frag.content
      ) {
        events.push({ type: "content", delta: frag.content });
        if (state) state.lastFragmentType = "RESPONSE";
      }
    }
    if (events.length) return events;
    return null;
  }

  // Fragment APPEND: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"{\""}]}
  // This adds a new fragment - we need to track its type
  if (data.p === "response/fragments" && data.o === "APPEND" && Array.isArray(data.v)) {
    for (const frag of data.v) {
      if (frag.type === "THINK" && frag.content) {
        if (state) state.lastFragmentType = "THINK";
        return { type: "thinking", delta: frag.content };
      } else if (frag.type === "RESPONSE" && frag.content) {
        if (state) state.lastFragmentType = "RESPONSE";
        return { type: "content", delta: frag.content };
      }
    }
    return null;
  }

  // Content/thinking APPEND: {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}
  // Route based on last fragment type
  if (data.p && data.p.endsWith("/content") && (data.o === "APPEND" || data.o === "SET")) {
    const value: string = data.v ?? "";
    if (typeof value === "string") {
      if (state && state.lastFragmentType === "THINK") {
        return { type: "thinking", delta: value };
      }
      return { type: "content", delta: value };
    }
    return null;
  }

  // Simple v-string delta: {"v":"text"}
  // Route based on last fragment type (after RESPONSE fragment is created, these are content)
  if (typeof data.v === "string" && data.v.length > 0 && !data.p) {
    if (state && state.lastFragmentType === "THINK") {
      return { type: "thinking", delta: data.v };
    }
    return { type: "content", delta: data.v };
  }

  // Patch/diff format without fragment context: {"p":".../content","o":"APPEND","v":"text"}
  if (data.p && data.o === "APPEND") {
    const path: string = data.p;
    const value: string = data.v ?? "";
    if (path.endsWith("/content") && typeof value === "string") {
      if (state && state.lastFragmentType === "THINK") {
        return { type: "thinking", delta: value };
      }
      return { type: "content", delta: value };
    }
    if (path.endsWith("/thinking") && typeof value === "string") {
      return { type: "thinking", delta: value };
    }
    return null;
  }

  // Track response_message_id + FINISHED
  if (data.response_message_id && data.v === "FINISHED") {
    return { type: "done", responseMessageId: Number(data.response_message_id) };
  }

  // Simple delta format: {"type":"delta","content":"text","index":0}
  if (data.type === "delta" && typeof data.content === "string") {
    return { type: "content", delta: data.content };
  }

  // Done (old format): {"type":"done","parent_message_id":"..."}
  if (data.type === "done") {
    const id = data.parent_message_id;
    return { type: "done", responseMessageId: id != null ? Number(id) : null };
  }

  // Error event
  if (data.type === "error") {
    return { type: "error" };
  }

  // Fallback: if we see "FINISHED" without response_message_id
  if (data.v === "FINISHED") {
    return { type: "done", responseMessageId: null };
  }

  return null;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<DeepSeekSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseMessageId: number | null = null;
  const state: SseParseState = { lastFragmentType: null, responseMessageId: null };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event: ")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const dataStr = trimmed.slice(6);

        // Capture response_message_id from any data line
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed?.response_message_id != null) {
            responseMessageId = Number(parsed.response_message_id);
          }
        } catch {
        }

        const result = parseSseLine(dataStr, state);
        if (result === null) continue;

        if (Array.isArray(result)) {
          for (const event of result) {
            if (event.type === "done" && event.responseMessageId === null && responseMessageId) {
              yield { type: "done", responseMessageId };
            } else {
              yield event;
            }
          }
        } else {
          if (result.type === "done" && result.responseMessageId === null && responseMessageId) {
            yield { type: "done", responseMessageId };
          } else {
            yield result;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function extractResponseMessageId(event: DeepSeekSseEvent): number | null {
  return event.type === "done" ? event.responseMessageId : null;
}

export async function chatStreamParsed(
  options: ChatStreamOptions,
  state: {
    authToken: string | null;
    cookieHeader: string | null;
    powSolver: DeepSeekPoWSolver | null;
    parentMessageId: number | null;
  },
  onEvent?: (event: DeepSeekSseEvent) => void
): Promise<number | null> {
  const resp = await chatStream(options, state);
  if (!resp.body) throw new Error("No response body in chat stream");

  let responseMessageId: number | null = null;
  const vjParser = createParser();
  let vjFailed = false;
  const xmlParser = new XmlToolCallParser();
  let xmlFailed = false;
  xmlParser.init().catch(() => { xmlFailed = true; });

  for await (const event of parseSseStream(resp.body)) {
    if (event.type === "content") {
      // Vectorjson: mid-stream JSON tool call detection
      if (!vjFailed) {
        const status = vjParser.feed(event.delta);
        if (status === "complete" || status === "end_early") {
          const value = vjParser.getValue() as any;
          if (typeof value === "object" && value !== null) {
            let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | null = null;
            // Format 1: {"tool_calls": [...]} or {"_calls": [...]}
            const arr = value?.tool_calls ?? value?._calls;
            if (Array.isArray(arr) && arr.length > 0) {
              toolCalls = arr.map((c: any) => ({
                name: String(c.name || c.function?.name || ""),
                arguments: typeof c.arguments === "string" ? JSON.parse(c.arguments) : (c.arguments || {}),
              }));
            }
            // Format 2: {"tool": "name", ...}
            if (!toolCalls && typeof value?.tool === "string" && value.tool) {
              const args = { ...value };
              delete args.tool;
              if (Object.keys(args).length > 0) {
                toolCalls = [{ name: value.tool, arguments: args }];
              }
            }
            if (toolCalls && onEvent) onEvent({ type: "tool_calls", calls: toolCalls });
          }
        } else if (status === "error") {
          vjFailed = true;
          vjParser.destroy();
        }
      }

      // Sax-wasm: mid-stream XML (DSML) tool call detection
      if (!xmlFailed && xmlParser.isReady) {
        xmlParser.feed(event.delta);
        const xmlCalls = xmlParser.getToolCalls();
        if (xmlCalls.length > 0 && onEvent) {
          onEvent({ type: "tool_calls", calls: xmlCalls });
        }
      }
    }

    if (event.type === "done") {
      // Flush any remaining XML tool calls
      if (!xmlFailed && xmlParser.isReady) {
        xmlParser.end();
        const xmlCalls = xmlParser.getToolCalls();
        if (xmlCalls.length > 0 && onEvent) {
          onEvent({ type: "tool_calls", calls: xmlCalls });
        }
      }
      responseMessageId = event.responseMessageId;
      state.parentMessageId = responseMessageId;
    }
    if (onEvent) onEvent(event);
  }

  if (!vjFailed) vjParser.destroy();
  xmlParser.destroy();

  return responseMessageId;
}

const isMainModule = process.argv[1]?.endsWith("web-api-client.ts");

if (isMainModule) {
  const result = await loadAuth();
  console.log(`token: ${result.token ? result.token.slice(0, 20) + "..." : "none"}`);
  console.log(`cookieCount: ${result.cookieHeader ? result.cookieHeader.split(";").length : 0}`);

  if (!result.token) {
    console.error("No auth token available. Set DEEPSEEK_TOKEN env var or ensure auth files exist.");
    process.exit(1);
  }

  const solver = new DeepSeekPoWSolver();
  await solver.init();
  console.log("powSolver: ready");

  const sessionId = await createSession(result.token, result.cookieHeader, "default");
  console.log(`sessionId: ${sessionId}`);

  process.exit(0);
}
