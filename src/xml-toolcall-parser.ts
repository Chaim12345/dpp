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

export class XmlToolCallParser {
  private parser: SAXParser | null = null;
  private results: ToolCall[] = [];
  private ready = false;
  private initPromise: Promise<void> | null = null;

  // Current state
  private inToolCalls = false;
  private currentInvoke: { name: string; params: Record<string, string> } | null = null;
  private currentParam: { name: string; value: string } | null = null;

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
        const name = detail.name.replace(/^｜｜DSML｜｜/, '');
        
        if (name === 'tool_calls' || name === 'function_calls' || name === 'pi-tool-calls') {
          this.inToolCalls = true;
        } else if (name === 'invoke' && this.inToolCalls) {
          const invokeName = this.getAttr(detail, 'name') || '';
          this.currentInvoke = { name: invokeName, params: {} };
        } else if ((name === 'parameter' || name === 'param') && this.currentInvoke) {
          const paramName = this.getAttr(detail, 'name') || '';
          this.currentParam = { name: paramName, value: '' };
        }
        break;
      }

      case SaxEventType.Text: {
        if (this.currentParam) {
          this.currentParam.value += detail.value;
        }
        break;
      }

      case SaxEventType.CloseTag: {
        const name = detail.name.replace(/^｜｜DSML｜｜/, '');
        
        if ((name === 'parameter' || name === 'param') && this.currentParam && this.currentInvoke) {
          // Close parameter, add to invoke
          this.currentInvoke.params[this.currentParam.name] = this.currentParam.value.trim();
          this.currentParam = null;
        } else if (name === 'invoke' && this.currentInvoke) {
          // Close invoke, emit tool call
          if (this.currentInvoke.name && Object.keys(this.currentInvoke.params).length > 0) {
            const args: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(this.currentInvoke.params)) {
              try {
                args[k] = JSON.parse(v);
              } catch {
                args[k] = v;
              }
            }
            this.results.push({ name: this.currentInvoke.name, arguments: args });
          }
          this.currentInvoke = null;
        } else if (name === 'tool_calls' || name === 'function_calls' || name === 'pi-tool-calls') {
          this.inToolCalls = false;
        }
        break;
      }
    }
  }

  private getAttr(tag: Tag, attrName: string): string | undefined {
    if (!tag.attributes) return undefined;
    for (const attr of tag.attributes) {
      if (attr.name?.value === attrName) return attr.value?.value;
    }
    return undefined;
  }

  feed(chunk: string): void {
    if (!this.parser) return;
    try {
      const bytes = new TextEncoder().encode(chunk);
      this.parser.write(bytes);
    } catch (e) {
      // SAX parser error, reset state
      this.reset();
    }
  }

  end(): void {
    if (this.parser) {
      this.parser.end();
    }
    // Flush any incomplete invoke
    if (this.currentInvoke && this.currentInvoke.name && Object.keys(this.currentInvoke.params).length > 0) {
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(this.currentInvoke.params)) {
        try {
          args[k] = JSON.parse(v);
        } catch {
          args[k] = v;
        }
      }
      this.results.push({ name: this.currentInvoke.name, arguments: args });
    }
  }

  getToolCalls(): ToolCall[] {
    const result = [...this.results];
    this.results = [];
    return result;
  }

  reset(): void {
    this.results = [];
    this.inToolCalls = false;
    this.currentInvoke = null;
    this.currentParam = null;
  }

  destroy(): void {
    this.parser = null;
    this.reset();
    this.ready = false;
    this.initPromise = null;
  }

  get isReady(): boolean {
    return this.ready;
  }
}
