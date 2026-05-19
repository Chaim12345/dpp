import { SAXParser, SaxEventType, type Tag } from 'sax-wasm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../node_modules/sax-wasm/lib/sax-wasm.wasm');

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

type Frame =
  | { type: 'tool_calls' }
  | { type: 'invoke'; name: string; params: Record<string, string> }
  | { type: 'parameter'; name: string };

const DSML_WRAPPERS = new Set(['tool_calls', 'function_calls', 'pi-tool-calls', '｜｜DSML｜｜tool_calls', '｜｜DSML｜｜function_calls', '｜｜DSML｜｜pi-tool-calls', '_calls']);

function getAttr(tag: Tag, attrName: string): string | undefined {
  if (!tag.attributes) return undefined;
  for (const attr of tag.attributes) {
    if (attr.name?.value === attrName) return attr.value?.value;
  }
  return undefined;
}

export class XmlToolCallParser {
  private parser: SAXParser | null = null;
  private stack: Frame[] = [];
  private results: ToolCall[] = [];
  private ready = false;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.parser = new SAXParser(
        SaxEventType.OpenTag | SaxEventType.CloseTag | SaxEventType.Text
      );
      const wasmBytes = await readFile(WASM_PATH);
      await this.parser.prepareWasm(wasmBytes);
      this.parser.eventHandler = (event, detail) => this.onEvent(event, detail as any);
      this.ready = true;
    })();

    return this.initPromise;
  }

  private onEvent(event: SaxEventType, detail: Tag): void {
    switch (event) {
      case SaxEventType.OpenTag: {
        const name = detail.name;
        // Handle both bare tags and DSML-prefixed tags (e.g., "｜｜DSML｜｜invoke")
        const bareName = name.replace(/^｜｜DSML｜｜/, '');
        if (DSML_WRAPPERS.has(name)) {
          this.stack.push({ type: 'tool_calls' });
        } else if (bareName === 'invoke') {
          const invokeName = getAttr(detail, 'name') || '';
          this.stack.push({ type: 'invoke', name: invokeName, params: {} });
        } else if (bareName === 'parameter') {
          const paramName = getAttr(detail, 'name') || '';
          this.stack.push({ type: 'parameter', name: paramName });
        }
        break;
      }
      case SaxEventType.Text: {
        const value = detail.value;
        if (this.stack.length >= 2) {
          const top = this.stack[this.stack.length - 1];
          const parent = this.stack[this.stack.length - 2];
          if (top.type === 'parameter' && parent.type === 'invoke') {
            parent.params[top.name] = (parent.params[top.name] || '') + value;
          }
        }
        break;
      }
      case SaxEventType.CloseTag: {
        const name = detail.name;
        const bareName = name.replace(/^｜｜DSML｜｜/, '');
        if (bareName === 'invoke') {
          while (this.stack.length > 0) {
            const frame = this.stack.pop()!;
            if (frame.type === 'invoke') {
              if (frame.name) {
                const args: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(frame.params)) {
                  try { args[k] = JSON.parse(v); } catch { args[k] = v; }
                }
                this.results.push({ name: frame.name, arguments: args });
              }
              break;
            }
          }
        } else if (bareName === 'parameter') {
          if (this.stack.length > 0 && this.stack[this.stack.length - 1].type === 'parameter') {
            this.stack.pop();
          }
        } else if (DSML_WRAPPERS.has(name)) {
          if (this.stack.length > 0 && this.stack[this.stack.length - 1].type === 'tool_calls') {
            this.stack.pop();
          }
        }
        break;
      }
    }
  }

  feed(chunk: string): void {
    if (!this.parser) return;
    const bytes = new TextEncoder().encode(chunk);
    this.parser.write(bytes);
  }

  end(): void {
    if (this.parser) this.parser.end();
  }

  getToolCalls(): ToolCall[] {
    const result = [...this.results];
    this.results = [];
    return result;
  }

  reset(): void {
    this.stack = [];
    this.results = [];
  }

  destroy(): void {
    this.parser = null;
    this.stack = [];
    this.results = [];
    this.ready = false;
    this.initPromise = null;
  }

  get isReady(): boolean {
    return this.ready;
  }
}

export const batchParser: XmlToolCallParser = new XmlToolCallParser();
let batchInitPromise: Promise<void> | null = null;
let batchReady = false;

export function isBatchReady(): boolean {
  return batchReady;
}

export function ensureBatchParser(): Promise<void> {
  if (batchReady) return Promise.resolve();
  if (batchInitPromise) return batchInitPromise;
  batchInitPromise = batchParser.init().then(() => { batchReady = true; });
  return batchInitPromise;
}
