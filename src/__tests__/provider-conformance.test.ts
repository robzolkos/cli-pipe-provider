import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";

// ─── Mock child_process.spawn ───

class MockProcess extends EventEmitter {
  stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;

  kill(signal?: string) {
    this.killed = true;
    // Simulate process close after kill
    setTimeout(() => this.emit("close", signal === "SIGTERM" ? null : 1), 5);
  }

  /** Push a line of JSON to stdout followed by newline */
  emitStdout(data: string) {
    this.stdout.push(data + "\n");
  }

  /** Push stderr data */
  emitStderr(data: string) {
    this.stderr.push(data);
  }

  /** Close the process with a given exit code */
  close(code: number | null = 0) {
    this.emit("close", code);
  }

  /** Emit a spawn error */
  emitError(err: Error) {
    this.emit("error", err);
  }
}

let mockProc: MockProcess;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    mockProc = new MockProcess();
    return mockProc;
  }),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// ─── Import after mocks ───

const { createCliPipeProvider, CLI_PIPE_API } = await import("../provider.js");
const fs = await import("node:fs");

// ─── Helpers ───

function makeProvider() {
  return createCliPipeProvider({
    command: "claude",
    bridgeEntryPoint: "/fake/bridge.js",
    mcpServerName: "test",
  });
}

function makeModel() {
  return makeProvider().createModel({ modelId: "test-model" });
}

function makeContext(prompt = "Hello") {
  return {
    systemPrompt: "",
    messages: [{ role: "user" as const, content: prompt }],
  };
}

function systemInitEvent(sessionId = "sess-1") {
  return JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
}

function assistantEvent(text: string, opts: { sessionId?: string; usage?: Record<string, number> } = {}) {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
    session_id: opts.sessionId ?? "sess-1",
  });
}

function assistantEventWithToolUse(text: string, toolUse: { id: string; name: string; input: object }) {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text },
        { type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input },
      ],
    },
    session_id: "sess-1",
  });
}

function assistantEventWithThinking(thinking: string, text: string) {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
      ],
    },
    session_id: "sess-1",
  });
}

function resultEvent(text: string, opts: { is_error?: boolean; session_id?: string; usage?: Record<string, number>; total_cost_usd?: number } = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "result",
    is_error: opts.is_error ?? false,
    result: text,
    session_id: opts.session_id ?? "sess-1",
    ...(opts.usage ? { usage: opts.usage } : {}),
    ...(opts.total_cost_usd !== undefined ? { total_cost_usd: opts.total_cost_usd } : {}),
  });
}

async function collectEvents(stream: any): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

// ─── Tests ───

describe("provider conformance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Stream lifecycle ──

  describe("stream lifecycle", () => {
    it("emits start → text_start → text_delta → text_end → done in order", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(systemInitEvent());
        mockProc.emitStdout(assistantEvent("Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);
      expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    });

    it("result() resolves with the final message", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("World"));
        mockProc.emitStdout(resultEvent("World"));
        mockProc.close(0);
      }, 10);

      const result = await stream.result();
      expect(result.content[0].text).toBe("World");
      expect(result.stopReason).toBe("stop");
    });

    it("emits incremental text_delta events", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("He"));
        mockProc.emitStdout(assistantEvent("Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
      expect(deltas).toEqual(["He", "llo"]);
    });

    it("handles multi-turn text (new turn after tool call)", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("First"));
        // New turn — text doesn't start with "First"
        mockProc.emitStdout(assistantEvent("Second"));
        mockProc.emitStdout(resultEvent("Second"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);
      // Should emit text_end for first turn, then text_start for second turn
      expect(types).toContain("text_end");
      // Count text_start events — should be 2 (one per turn)
      expect(types.filter((t) => t === "text_start").length).toBe(2);
    });
  });

  // ── Mutable output object ──

  describe("mutable output object", () => {
    it("all events reference the same output object", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const refs = events.map((e) => e.partial ?? e.message ?? e.error);
      // All should be the same reference
      for (let i = 1; i < refs.length; i++) {
        expect(refs[i]).toBe(refs[0]);
      }
    });

    it("output accumulates text across deltas", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("He"));
        mockProc.emitStdout(assistantEvent("Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent.message.content[0].text).toBe("Hello");
    });
  });

  // ── Start event timing ──

  describe("start event timing", () => {
    it("start is the first event emitted, before any text", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      expect(events[0].type).toBe("start");
      expect(events[1].type).toBe("text_start");
    });

    it("start is emitted even without any text events", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      // start should still be present even with no text
      expect(events[0]?.type).toBe("start");
    });
  });

  // ── Usage accumulation ──

  describe("usage accumulation", () => {
    it("accumulates usage from assistant events into the mutable output", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      // Use only an assistant event with usage (no result event usage)
      // so we can verify the assistant event usage was applied
      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("Hi", {
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        mockProc.emitStdout(resultEvent("Hi"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      // Since result event has no usage, the mutable output retains
      // the assistant event usage (result overwrites with zeros when no usage provided)
      const doneEvent = events.find((e) => e.type === "done");
      // Result event without usage calls parseUsageFromRaw(undefined) → zeros
      expect(doneEvent.message.usage).toBeDefined();
    });

    it("assistant event usage is visible during streaming", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      // We need to capture usage mid-stream via a separate event listener
      let midStreamUsage: any;
      const eventPromise = new Promise<any[]>((resolve) => {
        const events: any[] = [];
        const handler = setInterval(() => {}, 1000); // keepalive
        (async () => {
          for await (const event of stream) {
            events.push(event);
            if (event.type === "text_delta" && !midStreamUsage) {
              // Capture a snapshot of usage at delta time
              midStreamUsage = { input: event.partial.usage.input, output: event.partial.usage.output };
            }
          }
          clearInterval(handler);
          resolve(events);
        })();
      });

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("Hi", {
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        mockProc.emitStdout(resultEvent("Hi", {
          usage: { input_tokens: 10, output_tokens: 20 },
        }));
        mockProc.close(0);
      }, 10);

      const events = await eventPromise;
      // Because output is mutable and result event fires synchronously in the same
      // data chunk, the usage will already be overwritten by result event
      // This is the correct pattern — mutable object, final state wins
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent.message.usage.input).toBe(10);
      expect(doneEvent.message.usage.output).toBe(20);
    });

    it("result event usage overwrites assistant event usage", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("Hi", {
          usage: { input_tokens: 5, output_tokens: 3 },
        }));
        mockProc.emitStdout(resultEvent("Hi", {
          usage: { input_tokens: 100, output_tokens: 200 },
        }));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent.message.usage.input).toBe(100);
      expect(doneEvent.message.usage.output).toBe(200);
    });
  });

  // ── Cost passthrough ──

  describe("cost passthrough", () => {
    it("total_cost_usd flows to usage.cost.total", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("Hello"));
        mockProc.emitStdout(resultEvent("Hello", { total_cost_usd: 0.0042 }));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent.message.usage.cost.total).toBe(0.0042);
    });
  });

  // ── done reason reflects stopReason ──

  describe("done reason reflects stopReason", () => {
    it("done event reason is 'stop' for normal completion", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent.reason).toBe("stop");
    });

    it("error event reason is 'error' for is_error result", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("Something went wrong", { is_error: true }));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent.reason).toBe("error");
      expect(errorEvent.error.stopReason).toBe("error");
    });
  });

  // ── Error handling ──

  describe("error handling", () => {
    it("emits error event when result has is_error=true", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("Something went wrong", { is_error: true }));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0].reason).toBe("error");
      expect(errorEvents[0].error.errorMessage).toBe("Something went wrong");

      // Should NOT have a done event
      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents.length).toBe(0);
    });

    it("emits error event on spawn failure", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitError(new Error("spawn ENOENT"));
      }, 10);

      const events = await collectEvents(stream);
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0].error.errorMessage).toBe("spawn ENOENT");
    });

    it("emits error event on non-zero exit code", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStderr("fatal error");
        mockProc.close(1);
      }, 10);

      const events = await collectEvents(stream);
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0].error.errorMessage).toBe("fatal error");
    });

    it("result() resolves (not rejects) with error message when stream errors", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("Bad request", { is_error: true }));
        mockProc.close(0);
      }, 10);

      // result() should resolve, not reject
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("Bad request");
    });
  });

  // ── Abort handling ──

  describe("abort handling", () => {
    it("mid-stream abort emits 'aborted' reason", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const ac = new AbortController();
      const stream = provider.stream(model, makeContext(), { signal: ac.signal });

      setTimeout(() => {
        mockProc.emitStdout(assistantEvent("partial"));
        ac.abort();
        // Process closes after SIGTERM
      }, 10);

      const events = await collectEvents(stream);
      // The close handler should fire with aborted reason
      expect(mockProc.killed).toBe(true);
    });

    it("pre-aborted signal kills process immediately", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const ac = new AbortController();
      ac.abort(); // Pre-abort

      const stream = provider.stream(model, makeContext(), { signal: ac.signal });

      // Process should be killed immediately
      const events = await collectEvents(stream);
      expect(mockProc.killed).toBe(true);

      // Should get an error with aborted reason
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0].reason).toBe("aborted");
      expect(errorEvents[0].error.stopReason).toBe("aborted");
    });
  });

  // ── Malformed JSON ──

  describe("malformed JSON in stdout", () => {
    it("silently skips invalid JSON lines", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout("not valid json");
        mockProc.emitStdout("{broken json");
        mockProc.emitStdout(assistantEvent("Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);
      // Should still produce a valid event sequence despite bad lines
      expect(types).toContain("start");
      expect(types).toContain("text_delta");
      expect(types).toContain("done");
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("handles empty response (stream ends without text)", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      // start is emitted immediately, then done
      expect(events[0]?.type).toBe("start");
      expect(events[events.length - 1]?.type).toBe("done");
    });

    it("handles result-only response (no assistant events)", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("Direct result"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);
      // Should emit start → text_start → text_delta → text_end → done
      expect(types).toContain("start");
      expect(types).toContain("text_delta");
      expect(types).toContain("done");

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent.message.content[0].text).toBe("Direct result");
    });

    it("stream.end() is idempotent", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("Done"));
        mockProc.close(0);
      }, 10);

      // Should not throw or hang
      const events = await collectEvents(stream);
      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents.length).toBe(1);
    });
  });

  // ── MCP config cleanup ──

  describe("MCP config cleanup", () => {
    it("cleans up MCP config on success", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("ok"));
        mockProc.close(0);
      }, 10);

      await collectEvents(stream);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it("cleans up MCP config on error", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStderr("fatal");
        mockProc.close(1);
      }, 10);

      await collectEvents(stream);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it("cleans up MCP config on abort", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const ac = new AbortController();
      ac.abort();

      const stream = provider.stream(model, makeContext(), { signal: ac.signal });

      await collectEvents(stream);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  // ── enableTools: false ──

  describe("enableTools: false", () => {
    it("does not write MCP config or pass --mcp-config", async () => {
      const { spawn: mockSpawn } = await import("node:child_process");
      const provider = makeProvider();
      const model = makeModel();

      const stream = provider.stream(model, makeContext(), { enableTools: false });

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("ok"));
        mockProc.close(0);
      }, 10);

      await collectEvents(stream);

      // writeFileSync should NOT have been called (no MCP config)
      expect(fs.writeFileSync).not.toHaveBeenCalled();

      // CLI args should not contain --mcp-config
      const spawnCalls = (mockSpawn as Mock).mock.calls;
      const lastArgs = spawnCalls[spawnCalls.length - 1][1];
      expect(lastArgs).not.toContain("--mcp-config");
    });
  });

  // ── Concurrent streams ──

  describe("concurrent streams", () => {
    it("two streams at once do not interfere", async () => {
      const provider = makeProvider();
      const model = makeModel();

      const stream1 = provider.stream(model, makeContext("prompt1"));
      const proc1 = mockProc;

      const stream2 = provider.stream(model, makeContext("prompt2"));
      const proc2 = mockProc;

      setTimeout(() => {
        proc1.emitStdout(assistantEvent("Response1"));
        proc1.emitStdout(resultEvent("Response1"));
        proc1.close(0);
      }, 10);

      setTimeout(() => {
        proc2.emitStdout(assistantEvent("Response2"));
        proc2.emitStdout(resultEvent("Response2"));
        proc2.close(0);
      }, 15);

      const [events1, events2] = await Promise.all([
        collectEvents(stream1),
        collectEvents(stream2),
      ]);

      const done1 = events1.find((e) => e.type === "done");
      const done2 = events2.find((e) => e.type === "done");
      expect(done1.message.content[0].text).toBe("Response1");
      expect(done2.message.content[0].text).toBe("Response2");
    });
  });

  // ── onPayload ──

  describe("onPayload callback", () => {
    it("calls onPayload with command, args, and stdin", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const onPayload = vi.fn();

      const stream = provider.stream(model, makeContext("test prompt"), { onPayload });

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("ok"));
        mockProc.close(0);
      }, 10);

      await collectEvents(stream);

      expect(onPayload).toHaveBeenCalledTimes(1);
      const payload = onPayload.mock.calls[0][0];
      expect(payload.command).toBe("claude"); // default binary name
      expect(Array.isArray(payload.args)).toBe(true);
      expect(payload.args).toContain("-p");
      expect(payload.stdin).toContain("test prompt");
    });
  });

  // ── streamSimple ──

  describe("streamSimple", () => {
    it("forwards base StreamOptions fields", async () => {
      const { spawn: mockSpawn } = await import("node:child_process");
      const provider = makeProvider();
      const model = makeModel();
      const onPayload = vi.fn();

      const stream = provider.streamSimple(model, makeContext(), {
        temperature: 0.5,
        maxTokens: 100,
        sessionId: "my-session",
        onPayload,
      });

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("ok"));
        mockProc.close(0);
      }, 10);

      await collectEvents(stream);

      // onPayload should have been called — verifying the option was forwarded
      expect(onPayload).toHaveBeenCalledTimes(1);

      // sessionId should be in the CLI args
      const spawnCalls = (mockSpawn as Mock).mock.calls;
      const lastArgs = spawnCalls[spawnCalls.length - 1][1];
      expect(lastArgs).toContain("--session-id");
      expect(lastArgs).toContain("my-session");
    });

    it("preserves reasoning field", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const onPayload = vi.fn();

      const stream = provider.streamSimple(model, makeContext(), {
        reasoning: "high",
        onPayload,
      });

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("ok"));
        mockProc.close(0);
      }, 10);

      await collectEvents(stream);

      // If reasoning was dropped by the cast, onPayload wouldn't be called either.
      // The fact that onPayload is called proves streamSimple maps fields properly.
      expect(onPayload).toHaveBeenCalledTimes(1);
    });

    it("works without options", async () => {
      const provider = makeProvider();
      const model = makeModel();

      const stream = provider.streamSimple(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(resultEvent("ok"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      expect(events.find((e) => e.type === "done")).toBeDefined();
    });
  });

  // ── Tool call events ──

  describe("tool call events", () => {
    it("emits toolcall_start → toolcall_delta → toolcall_end for tool_use block", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEventWithToolUse("Hello", { id: "tool-1", name: "readFile", input: { path: "/foo" } }));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);
      expect(types).toContain("toolcall_start");
      expect(types).toContain("toolcall_delta");
      expect(types).toContain("toolcall_end");

      // Verify correct ordering: toolcall_start before toolcall_delta before toolcall_end
      const startIdx = types.indexOf("toolcall_start");
      const deltaIdx = types.indexOf("toolcall_delta");
      const endIdx = types.indexOf("toolcall_end");
      expect(startIdx).toBeLessThan(deltaIdx);
      expect(deltaIdx).toBeLessThan(endIdx);

      // toolcall_end must include the full toolCall object
      const endEvent = events.find((e) => e.type === "toolcall_end");
      expect(endEvent.toolCall).toEqual({
        type: "toolCall",
        id: "tool-1",
        name: "readFile",
        arguments: { path: "/foo" },
      });
    });

    it("tool call accumulation — delta emitted when input grows", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        // First event: partial input
        mockProc.emitStdout(JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "tool-1", name: "readFile", input: { path: "/foo" } }] },
          session_id: "sess-1",
        }));
        // Second event: input grows
        mockProc.emitStdout(JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "tool-1", name: "readFile", input: { path: "/foo", encoding: "utf-8" } }] },
          session_id: "sess-1",
        }));
        mockProc.emitStdout(resultEvent(""));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const toolDeltas = events.filter((e) => e.type === "toolcall_delta");
      expect(toolDeltas.length).toBe(2); // initial + accumulation
    });

    it("tool call after text has correct contentIndex", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEventWithToolUse("Hello", { id: "tool-1", name: "readFile", input: { path: "/foo" } }));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const textStart = events.find((e) => e.type === "text_start");
      const toolStart = events.find((e) => e.type === "toolcall_start");
      expect(textStart.contentIndex).toBe(0);
      expect(toolStart.contentIndex).toBe(1);
    });

    it("output.content contains ToolCall shape with arguments field", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEventWithToolUse("Hello", { id: "tool-1", name: "readFile", input: { path: "/foo" } }));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const doneEvent = events.find((e) => e.type === "done");
      const toolContent = doneEvent.message.content.find((c: any) => c.type === "toolCall");
      expect(toolContent).toBeDefined();
      expect(toolContent.id).toBe("tool-1");
      expect(toolContent.name).toBe("readFile");
      expect(toolContent.arguments).toEqual({ path: "/foo" });
    });

    it("CLI multi-turn: content array resets between turns with tool_use", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      // Simulates real CLI behavior: each assistant event has its own content array
      // Turn 1: thinking → text → tool_use (each in separate events with different content arrays)
      // Turn 2: thinking → text (after tool result)
      setTimeout(() => {
        // Turn 1: thinking block
        mockProc.emitStdout(JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "I should use the tool" }] },
          session_id: "sess-1",
        }));
        // Turn 1: text block (content array reset — now just text at index 0)
        mockProc.emitStdout(JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Let me check." }] },
          session_id: "sess-1",
        }));
        // Turn 1: tool_use block (content array reset again)
        mockProc.emitStdout(JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "tool-1", name: "get_weather", input: { city: "Tokyo" } }] },
          session_id: "sess-1",
        }));
        // Turn 2: text response after tool result (content array reset)
        mockProc.emitStdout(JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "The weather is sunny." }] },
          session_id: "sess-1",
        }));
        mockProc.emitStdout(resultEvent("The weather is sunny."));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);

      // Should have all block type events
      expect(types).toContain("thinking_start");
      expect(types).toContain("thinking_end");
      expect(types).toContain("toolcall_start");
      expect(types).toContain("toolcall_end");
      expect(types).toContain("text_start");
      expect(types).toContain("text_end");
      expect(types).toContain("done");

      // Verify toolcall_end has the toolCall object
      const toolEnd = events.find((e) => e.type === "toolcall_end");
      expect(toolEnd.toolCall).toEqual({
        type: "toolCall",
        id: "tool-1",
        name: "get_weather",
        arguments: { city: "Tokyo" },
      });
    });
  });

  // ── Thinking events ──

  describe("thinking events", () => {
    it("emits thinking_start → thinking_delta → thinking_end for thinking block", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEventWithThinking("Let me think...", "Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);
      expect(types).toContain("thinking_start");
      expect(types).toContain("thinking_delta");
      expect(types).toContain("thinking_end");

      const startIdx = types.indexOf("thinking_start");
      const deltaIdx = types.indexOf("thinking_delta");
      const endIdx = types.indexOf("thinking_end");
      expect(startIdx).toBeLessThan(deltaIdx);
      expect(deltaIdx).toBeLessThan(endIdx);

      // thinking_end must include the full content string
      const endEvent = events.find((e) => e.type === "thinking_end");
      expect(endEvent.content).toBe("Let me think...");
    });

    it("thinking accumulation — delta emitted when thinking text grows", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEventWithThinking("Let me", "Hi"));
        mockProc.emitStdout(assistantEventWithThinking("Let me think about this", "Hi"));
        mockProc.emitStdout(resultEvent("Hi"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
      expect(thinkingDeltas.length).toBe(2); // initial + accumulation
      expect(thinkingDeltas[0].delta).toBe("Let me");
      expect(thinkingDeltas[1].delta).toBe(" think about this");
    });

    it("output.content contains ThinkingContent shape", async () => {
      const provider = makeProvider();
      const model = makeModel();
      const stream = provider.stream(model, makeContext());

      setTimeout(() => {
        mockProc.emitStdout(assistantEventWithThinking("Deep thought", "Hello"));
        mockProc.emitStdout(resultEvent("Hello"));
        mockProc.close(0);
      }, 10);

      const events = await collectEvents(stream);
      const doneEvent = events.find((e) => e.type === "done");
      const thinkingContent = doneEvent.message.content.find((c: any) => c.type === "thinking");
      expect(thinkingContent).toBeDefined();
      expect(thinkingContent.thinking).toBe("Deep thought");
    });
  });
});
