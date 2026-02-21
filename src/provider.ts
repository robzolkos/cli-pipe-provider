import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, registerApiProvider } from "@mariozechner/pi-ai";
import type {
  CliPipeProviderOptions,
  CliPipeStreamOptions,
  CliSystemEvent,
  CliAssistantEvent,
  CliResultEvent,
  CliStreamEvent,
  CliPipeProvider,
  CliContentBlock,
  McpConfig,
} from "./types.js";
import { emptyUsage, parseUsageFromRaw, extractTextContent } from "./utils.js";

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

/** Custom API identifier for cli-pipe */
export const CLI_PIPE_API = "cli-pipe" as Api;

// ─── MCP Config Generation ───

function writeMcpConfig(
  bridgeEntryPoint: string,
  mcpServerName: string,
  bridgeArgs: string[],
): string {
  const config: McpConfig = {
    mcpServers: {
      [mcpServerName]: {
        command: "node",
        args: [bridgeEntryPoint, ...bridgeArgs],
      },
    },
  };

  const tmpDir = os.tmpdir();
  const configPath = path.join(tmpDir, `${mcpServerName}-mcp-${Date.now()}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}

function cleanupMcpConfig(configPath: string): void {
  try {
    fs.unlinkSync(configPath);
  } catch {
    // Best effort cleanup
  }
}

// ─── CLI arg building ───

function buildCliArgs(
  model: Model<Api>,
  mcpServerName: string,
  options?: CliPipeStreamOptions,
  mcpConfigPath?: string,
): string[] {
  const args = ["-p", "--output-format", "stream-json"];

  if (model.id && model.id !== "default") {
    args.push("--model", model.id);
  }

  if (options?.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  // MCP tool bridge
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
    args.push("--allowedTools", `mcp__${mcpServerName}__*`);
  }

  return args;
}

function buildStdinPayload(context: Context): string {
  const parts: string[] = [];

  if (context.systemPrompt) {
    parts.push(context.systemPrompt);
    parts.push("\n---\n");
  }

  // Include conversation history for continuity
  // CLI pipe mode is stateless, so we must pass the full context
  if (context.messages.length > 1) {
    parts.push("## Conversation History\n");
    const history = context.messages.slice(0, -1);
    for (const msg of history) {
      if (msg.role === "user") {
        const text = extractTextContent(msg.content as string | Array<{ type: string; text?: string }>);
        parts.push(`User: ${text}`);
      } else if (msg.role === "assistant") {
        const content = (msg as any).content;
        const text = extractTextContent(content);
        parts.push(`Assistant: ${text}`);
      }
    }
    parts.push("\n---\n");
  }

  // The last message is the current prompt
  const lastMsg = context.messages[context.messages.length - 1];
  if (lastMsg?.role === "user") {
    parts.push(extractTextContent(lastMsg.content as string | Array<{ type: string; text?: string }>));
  }

  return parts.join("\n");
}

// ─── Stream function factory ───

function createStreamFunction(
  providerOpts: CliPipeProviderOptions,
): StreamFunction<Api, CliPipeStreamOptions> {
  return (
    model: Model<Api>,
    context: Context,
    options?: CliPipeStreamOptions,
  ): AssistantMessageEventStream => {
    const eventStream = createAssistantMessageEventStream();

    // Merge bridge args: resolved from model + provider defaults + per-call overrides
    const bridgeArgs = [
      ...(providerOpts.resolveBridgeArgs?.(model) ?? []),
      ...(providerOpts.bridgeArgs ?? []),
      ...(options?.bridgeArgs ?? []),
    ];

    // Generate MCP config if tools are enabled
    const enableTools = options?.enableTools !== false;
    let mcpConfigPath: string | undefined;

    if (enableTools) {
      mcpConfigPath = writeMcpConfig(
        providerOpts.bridgeEntryPoint,
        providerOpts.mcpServerName,
        bridgeArgs,
      );
    }

    const args = buildCliArgs(model, providerOpts.mcpServerName, options, mcpConfigPath);
    const stdin = buildStdinPayload(context);

    // Remove nesting-detection env var to avoid nested invocation errors
    const env = { ...process.env };
    delete env.CLAUDECODE; // runtime env var set by the CLI

    const command = providerOpts.command;

    // onPayload callback
    options?.onPayload?.({ command, args, stdin });

    // Single mutable output object — mutated throughout the stream
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: CLI_PIPE_API,
      provider: "cli-pipe",
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    // Abort handling — kill the process on signal
    if (options?.signal) {
      if (options.signal.aborted) {
        proc.kill("SIGTERM");
      } else {
        options.signal.addEventListener("abort", () => {
          proc.kill("SIGTERM");
        });
      }
    }

    // Write input and close stdin
    proc.stdin.write(stdin);
    proc.stdin.end();

    // Async IIFE — mirrors the standard streaming pattern
    (async () => {
      try {
        // Emit start immediately before any stdout data
        eventStream.push({ type: "start", partial: output });

        interface TrackedBlock {
          type: "text" | "tool_use" | "thinking";
          started: boolean;
          ended: boolean;
          text?: string;
          id?: string;
          name?: string;
          inputJson?: string;
          thinking?: string;
        }

        function rebuildOutputContent(tracked: TrackedBlock[]): AssistantMessage["content"] {
          return tracked.map((b) => {
            if (b.type === "text") return { type: "text" as const, text: b.text ?? "" };
            if (b.type === "tool_use") return { type: "toolCall" as const, id: b.id ?? "", name: b.name ?? "", arguments: JSON.parse(b.inputJson ?? "{}") };
            return { type: "thinking" as const, thinking: b.thinking ?? "" };
          });
        }

        const blocks: TrackedBlock[] = [];
        let sessionId: string | undefined = options?.sessionId;
        let buffer = "";
        let stderrOutput = "";

        // Collect stderr
        proc.stderr.on("data", (data: Buffer) => {
          stderrOutput += data.toString();
        });

        // Process stdout as a promise that resolves on close, rejects on error
        await new Promise<void>((resolve, reject) => {
          proc.stdout.on("data", (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              let event: CliStreamEvent;
              try {
                event = JSON.parse(trimmed);
              } catch {
                continue; // Skip malformed JSON lines
              }

              if (event.type === "system" && (event as CliSystemEvent).subtype === "init") {
                sessionId = (event as CliSystemEvent).session_id;
              } else if (event.type === "assistant") {
                const assistantEvent = event as CliAssistantEvent;

                // Accumulate usage from assistant events
                if (assistantEvent.message?.usage) {
                  const parsed = parseUsageFromRaw(assistantEvent.message.usage);
                  output.usage.input = parsed.input;
                  output.usage.output = parsed.output;
                  output.usage.cacheRead = parsed.cacheRead;
                  output.usage.cacheWrite = parsed.cacheWrite;
                  output.usage.totalTokens = parsed.totalTokens;
                }

                const contentArray = assistantEvent.message?.content ?? [];

                for (let i = 0; i < contentArray.length; i++) {
                  const block = contentArray[i];

                  if (i >= blocks.length) {
                    // New block — emit *_start + initial *_delta
                    if (block.type === "text") {
                      const tracked: TrackedBlock = { type: "text", started: true, ended: false, text: block.text };
                      blocks.push(tracked);
                      output.content = rebuildOutputContent(blocks);
                      eventStream.push({ type: "text_start", contentIndex: i, partial: output });
                      if (block.text) {
                        eventStream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: output });
                      }
                    } else if (block.type === "tool_use") {
                      const inputJson = JSON.stringify(block.input);
                      const tracked: TrackedBlock = { type: "tool_use", started: true, ended: false, id: block.id, name: block.name, inputJson };
                      blocks.push(tracked);
                      output.content = rebuildOutputContent(blocks);
                      eventStream.push({ type: "toolcall_start", contentIndex: i, partial: output });
                      eventStream.push({ type: "toolcall_delta", contentIndex: i, delta: inputJson, partial: output });
                    } else if (block.type === "thinking") {
                      const tracked: TrackedBlock = { type: "thinking", started: true, ended: false, thinking: block.thinking };
                      blocks.push(tracked);
                      output.content = rebuildOutputContent(blocks);
                      eventStream.push({ type: "thinking_start", contentIndex: i, partial: output });
                      if (block.thinking) {
                        eventStream.push({ type: "thinking_delta", contentIndex: i, delta: block.thinking, partial: output });
                      }
                    }
                  } else {
                    // Existing block — emit deltas for changes
                    const tracked = blocks[i];

                    // Type changed at this index — CLI reset content array (new turn)
                    // End all open blocks and treat remaining CLI blocks as new appended blocks
                    if (block.type !== tracked.type) {
                      for (let j = 0; j < blocks.length; j++) {
                        const tb = blocks[j];
                        if (tb.started && !tb.ended) {
                          tb.ended = true;
                          if (tb.type === "text") {
                            eventStream.push({ type: "text_end", contentIndex: j, content: tb.text ?? "", partial: output });
                          } else if (tb.type === "tool_use") {
                            eventStream.push({
                              type: "toolcall_end",
                              contentIndex: j,
                              toolCall: { type: "toolCall" as const, id: tb.id ?? "", name: tb.name ?? "", arguments: JSON.parse(tb.inputJson ?? "{}") },
                              partial: output,
                            });
                          } else if (tb.type === "thinking") {
                            eventStream.push({ type: "thinking_end", contentIndex: j, content: tb.thinking ?? "", partial: output });
                          }
                        }
                      }
                      // Mark turn boundary — remaining CLI content blocks (from index i onward) get appended
                      // as new blocks at the end of our blocks array
                      for (let k = i; k < contentArray.length; k++) {
                        const newBlock = contentArray[k];
                        const newIdx = blocks.length;
                        if (newBlock.type === "text") {
                          blocks.push({ type: "text", started: true, ended: false, text: newBlock.text });
                          output.content = rebuildOutputContent(blocks);
                          eventStream.push({ type: "text_start", contentIndex: newIdx, partial: output });
                          if (newBlock.text) eventStream.push({ type: "text_delta", contentIndex: newIdx, delta: newBlock.text, partial: output });
                        } else if (newBlock.type === "tool_use") {
                          const inputJson = JSON.stringify(newBlock.input);
                          blocks.push({ type: "tool_use", started: true, ended: false, id: newBlock.id, name: newBlock.name, inputJson });
                          output.content = rebuildOutputContent(blocks);
                          eventStream.push({ type: "toolcall_start", contentIndex: newIdx, partial: output });
                          eventStream.push({ type: "toolcall_delta", contentIndex: newIdx, delta: inputJson, partial: output });
                        } else if (newBlock.type === "thinking") {
                          blocks.push({ type: "thinking", started: true, ended: false, thinking: newBlock.thinking });
                          output.content = rebuildOutputContent(blocks);
                          eventStream.push({ type: "thinking_start", contentIndex: newIdx, partial: output });
                          if (newBlock.thinking) eventStream.push({ type: "thinking_delta", contentIndex: newIdx, delta: newBlock.thinking, partial: output });
                        }
                      }
                      break; // We processed all remaining CLI blocks above
                    }

                    if (block.type === "text" && tracked.type === "text") {
                      const prevText = tracked.text ?? "";
                      const newText = block.text;
                      if (newText.startsWith(prevText) && newText.length > prevText.length) {
                        const delta = newText.slice(prevText.length);
                        tracked.text = newText;
                        output.content = rebuildOutputContent(blocks);
                        eventStream.push({ type: "text_delta", contentIndex: i, delta, partial: output });
                      } else if (!newText.startsWith(prevText)) {
                        // New turn — text doesn't continue from previous
                        eventStream.push({ type: "text_end", contentIndex: i, content: prevText, partial: output });
                        tracked.text = newText;
                        output.content = rebuildOutputContent(blocks);
                        eventStream.push({ type: "text_start", contentIndex: i, partial: output });
                        if (newText) {
                          eventStream.push({ type: "text_delta", contentIndex: i, delta: newText, partial: output });
                        }
                      }
                    } else if (block.type === "tool_use" && tracked.type === "tool_use") {
                      const newInputJson = JSON.stringify(block.input);
                      if (newInputJson !== tracked.inputJson) {
                        tracked.inputJson = newInputJson;
                        tracked.id = block.id;
                        tracked.name = block.name;
                        output.content = rebuildOutputContent(blocks);
                        eventStream.push({ type: "toolcall_delta", contentIndex: i, delta: newInputJson, partial: output });
                      }
                    } else if (block.type === "thinking" && tracked.type === "thinking") {
                      const prevThinking = tracked.thinking ?? "";
                      const newThinking = block.thinking;
                      if (newThinking.startsWith(prevThinking) && newThinking.length > prevThinking.length) {
                        const delta = newThinking.slice(prevThinking.length);
                        tracked.thinking = newThinking;
                        output.content = rebuildOutputContent(blocks);
                        eventStream.push({ type: "thinking_delta", contentIndex: i, delta, partial: output });
                      }
                    }
                  }
                }
              } else if (event.type === "result") {
                const resultEvent = event as CliResultEvent;
                const resultText = resultEvent.result;

                // Update the last text block with result text, or create one
                if (resultText) {
                  const lastTextIdx = findLastIndex(blocks, (b) => b.type === "text");
                  if (lastTextIdx >= 0) {
                    blocks[lastTextIdx].text = resultText;
                  } else {
                    // No text blocks yet — create one
                    const tracked: TrackedBlock = { type: "text", started: false, ended: false, text: resultText };
                    blocks.push(tracked);
                  }
                  output.content = rebuildOutputContent(blocks);
                }

                // Emit text_start/delta for result-only responses (no prior assistant events)
                const resultTextIdx = findLastIndex(blocks, (b) => b.type === "text");
                if (resultTextIdx >= 0 && !blocks[resultTextIdx].started && resultText) {
                  blocks[resultTextIdx].started = true;
                  eventStream.push({ type: "text_start", contentIndex: resultTextIdx, partial: output });
                  eventStream.push({
                    type: "text_delta",
                    contentIndex: resultTextIdx,
                    delta: resultText,
                    partial: output,
                  });
                }

                if (resultEvent.session_id) {
                  sessionId = resultEvent.session_id;
                }

                // Result event usage overwrites with final totals
                const usage = parseUsageFromRaw(resultEvent.usage);
                if (resultEvent.total_cost_usd) {
                  usage.cost.total = resultEvent.total_cost_usd;
                }
                output.usage = usage;

                output.stopReason = resultEvent.is_error ? "error" : "stop";
                if (resultEvent.is_error) {
                  output.errorMessage = resultText;
                }

                // End all open blocks
                for (let i = 0; i < blocks.length; i++) {
                  const tracked = blocks[i];
                  if (tracked.started && !tracked.ended) {
                    tracked.ended = true;
                    if (tracked.type === "text") {
                      eventStream.push({ type: "text_end", contentIndex: i, content: tracked.text ?? "", partial: output });
                    } else if (tracked.type === "tool_use") {
                      eventStream.push({
                        type: "toolcall_end",
                        contentIndex: i,
                        toolCall: { type: "toolCall" as const, id: tracked.id ?? "", name: tracked.name ?? "", arguments: JSON.parse(tracked.inputJson ?? "{}") },
                        partial: output,
                      });
                    } else if (tracked.type === "thinking") {
                      eventStream.push({ type: "thinking_end", contentIndex: i, content: tracked.thinking ?? "", partial: output });
                    }
                  }
                }
              }
            }
          });

          proc.on("error", (err) => {
            reject(err);
          });

          proc.on("close", (code) => {
            const hasContent = blocks.some((b) => b.type === "text" ? (b.text ?? "").length > 0 : true);
            if (code !== 0 && !hasContent) {
              const msg = stderrOutput || `CLI process exited with code ${code}`;
              reject(new Error(msg));
            } else {
              resolve();
            }
          });
        });

        // After processing completes: check abort
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }

        // Success path: push done event using output.stopReason
        if (output.stopReason === "error" || output.stopReason === "aborted") {
          eventStream.push({ type: "error", reason: output.stopReason, error: output });
        } else {
          eventStream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
        }
        eventStream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        eventStream.push({ type: "error", reason: output.stopReason, error: output });
        eventStream.end();
      } finally {
        if (mcpConfigPath) cleanupMcpConfig(mcpConfigPath);
      }
    })();

    return eventStream;
  };
}

// ─── Public factory ───

/**
 * Create a cli-pipe provider that wraps CLI pipe mode with MCP tool bridge support.
 *
 * ```ts
 * const pipe = createCliPipeProvider({
 *   command: "claude",  // or any CLI that supports -p --output-format stream-json
 *   bridgeEntryPoint: "/path/to/my-bridge.js",
 *   mcpServerName: "my-app",
 * });
 * pipe.register();
 * const model = pipe.createModel({ modelId: "claude-sonnet-4-6" });
 * ```
 */
export function createCliPipeProvider(options: CliPipeProviderOptions): CliPipeProvider {
  const streamFn = createStreamFunction(options);

  // streamSimple — explicitly map SimpleStreamOptions fields
  const streamSimpleFn: StreamFunction<Api, SimpleStreamOptions> = (
    model: Model<Api>,
    context: Context,
    opts?: SimpleStreamOptions,
  ) => {
    if (!opts) return streamFn(model, context);
    const mapped: CliPipeStreamOptions = {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      apiKey: opts.apiKey,
      transport: opts.transport,
      cacheRetention: opts.cacheRetention,
      sessionId: opts.sessionId,
      onPayload: opts.onPayload,
      headers: opts.headers,
      maxRetryDelayMs: opts.maxRetryDelayMs,
      metadata: opts.metadata,
      reasoning: opts.reasoning,
    };
    return streamFn(model, context, mapped);
  };

  return {
    api: CLI_PIPE_API,
    stream: streamFn,
    streamSimple: streamSimpleFn,

    register() {
      registerApiProvider({
        api: CLI_PIPE_API,
        stream: streamFn,
        streamSimple: streamSimpleFn,
      });
    },

    createModel(opts?: { modelId?: string }): Model<Api> {
      const modelId = opts?.modelId ?? "claude-sonnet-4-6";
      return {
        id: modelId,
        name: `${modelId} via CLI pipe`,
        api: CLI_PIPE_API,
        provider: "cli-pipe",
        baseUrl: "",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      } as Model<Api>;
    },
  };
}
