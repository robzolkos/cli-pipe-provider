/**
 * Integration test — runs against real CLI pipe mode with your account.
 * Usage: npx tsx scripts/integration-test.ts
 */
import * as path from "node:path";
import { createCliPipeProvider } from "../src/provider.ts";

const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);

// Provider without tools (text + thinking tests)
const noToolsProvider = createCliPipeProvider({
  command: "claude",
  bridgeEntryPoint: "/dev/null",
  mcpServerName: "test",
});

// Provider with raw MCP bridge (.mjs — runs with node directly)
const rawBridgeProvider = createCliPipeProvider({
  command: "claude",
  bridgeEntryPoint: path.join(SCRIPTS_DIR, "fixtures/raw-mcp-bridge.mjs"),
  mcpServerName: "test-raw",
});

// Provider with AgentTool bridge (.mjs — uses built dist/)
const agentToolBridgeProvider = createCliPipeProvider({
  command: "claude",
  bridgeEntryPoint: path.join(SCRIPTS_DIR, "fixtures/agent-tool-bridge.mjs"),
  mcpServerName: "test-agent-tool",
});

const model = noToolsProvider.createModel({ modelId: "claude-opus-4-6" });

// ── Test 1: Basic text streaming ──

async function testTextStreaming() {
  console.log("\n=== Test 1: Basic text streaming ===\n");

  const stream = noToolsProvider.stream(
    model,
    {
      systemPrompt: "",
      messages: [{ role: "user" as const, content: "Reply with exactly: Hello world" }],
    },
    { enableTools: false },
  );

  const events: any[] = [];
  for await (const event of stream) {
    console.log(formatEvent(event));
    events.push(event);
  }

  const types = events.map((e) => e.type);
  assertContains("Test 1", types, "start", "text_start", "text_delta", "text_end", "done");
  console.log("\n[PASS] Text streaming\n");
}

// ── Test 2: Thinking blocks ──

async function testThinkingBlocks() {
  console.log("\n=== Test 2: Thinking blocks ===\n");

  const stream = noToolsProvider.stream(
    model,
    {
      systemPrompt: "",
      messages: [{ role: "user" as const, content: "What is 137 * 29?" }],
    },
    { enableTools: false },
  );

  const events: any[] = [];
  for await (const event of stream) {
    console.log(formatEvent(event));
    events.push(event);
  }

  const types = events.map((e) => e.type);
  if (types.includes("thinking_start")) {
    assertContains("Test 2 thinking", types, "thinking_start", "thinking_delta", "thinking_end");

    // Verify thinking_end has content field
    const thinkingEnd = events.find((e) => e.type === "thinking_end");
    if (!thinkingEnd?.content) {
      fail("Test 2", "thinking_end missing content field");
    }

    console.log("[PASS] Thinking events with correct shape!");
  } else {
    console.log("[INFO] No thinking blocks emitted");
  }

  assertContains("Test 2", types, "start", "done");
  console.log("[PASS] Lifecycle\n");
}

// ── Test 3: Output content shape ──

async function testOutputContent() {
  console.log("\n=== Test 3: output.content shape ===\n");

  const stream = noToolsProvider.stream(
    model,
    {
      systemPrompt: "",
      messages: [{ role: "user" as const, content: "Say hi in one word." }],
    },
    { enableTools: false },
  );

  const result = await stream.result();
  console.log("output.content:");
  for (const block of result.content as any[]) {
    console.log("  type=" + block.type, JSON.stringify(block).slice(0, 120));
  }
  console.log("stopReason:", result.stopReason);
  console.log("usage.cost.total:", result.usage.cost.total);

  const textBlocks = (result.content as any[]).filter((c: any) => c.type === "text");
  if (textBlocks.length === 0) fail("Test 3", "No text content in output");

  const thinkingBlocks = (result.content as any[]).filter((c: any) => c.type === "thinking");
  for (const tb of thinkingBlocks) {
    if (typeof tb.thinking !== "string") fail("Test 3", "thinking block missing .thinking field");
  }

  console.log("\n[PASS] Output content shape\n");
}

// ── Test 4: Tool use via raw MCP bridge ──

async function testToolUseRawBridge() {
  console.log("\n=== Test 4: Tool use (raw MCP bridge) ===\n");
  await runToolUseTest(rawBridgeProvider, "Test 4");
}

// ── Test 5: Tool use via AgentTool bridge ──

async function testToolUseAgentBridge() {
  console.log("\n=== Test 5: Tool use (AgentTool bridge) ===\n");
  await runToolUseTest(agentToolBridgeProvider, "Test 5");
}

async function runToolUseTest(prov: ReturnType<typeof createCliPipeProvider>, label: string) {
  const stream = prov.stream(
    model,
    {
      systemPrompt: "You have a get_weather tool. Use it to answer the user's question. Call the tool first, then respond with the result.",
      messages: [{ role: "user" as const, content: "What's the weather in Tokyo?" }],
    },
    {
      enableTools: true,
      onPayload: (p) => console.log("  CLI args:", p.args.join(" ")),
    },
  );

  const events: any[] = [];
  for await (const event of stream) {
    console.log(formatEvent(event));
    events.push(event);
  }

  const types = events.map((e) => e.type);
  console.log("\nEvent types seen:", [...new Set(types)].join(", "));

  // We expect text events at minimum
  assertContains(label, types, "start", "text_start", "text_delta", "text_end", "done");

  // Check for tool call events
  if (types.includes("toolcall_start")) {
    assertContains(label + " toolcall", types, "toolcall_start", "toolcall_delta", "toolcall_end");

    // Verify toolcall_end has the full toolCall object
    const toolEnd = events.find((e) => e.type === "toolcall_end");
    if (!toolEnd?.toolCall) fail(label, "toolcall_end missing toolCall field");
    if (toolEnd.toolCall.type !== "toolCall") fail(label, "toolCall.type should be 'toolCall'");
    if (!toolEnd.toolCall.name) fail(label, "toolCall.name should be set");
    if (!toolEnd.toolCall.arguments) fail(label, "toolCall.arguments should be set");
    console.log("  toolCall:", JSON.stringify(toolEnd.toolCall));

    // Verify output.content has ToolCall entries
    const doneEvent = events.find((e) => e.type === "done");
    const toolCallContent = (doneEvent.message.content as any[]).filter((c: any) => c.type === "toolCall");
    if (toolCallContent.length === 0) fail(label, "output.content has no toolCall entries");
    console.log("  output toolCall:", JSON.stringify(toolCallContent[0]).slice(0, 120));

    console.log("[PASS] Tool call events with correct shape!");
  } else {
    console.log("[WARN] No toolcall events — CLI may not have used the tool");
  }

  console.log("[PASS] " + label + "\n");
}

// ── Helpers ──

function formatEvent(event: any): string {
  const parts = ["  " + String(event.type).padEnd(18)];
  if (event.contentIndex !== undefined) parts.push("idx=" + event.contentIndex);
  if (event.delta !== undefined) parts.push("delta=" + JSON.stringify(event.delta).slice(0, 80));
  if (event.content !== undefined) parts.push("content=" + JSON.stringify(event.content).slice(0, 80));
  if (event.toolCall) parts.push("toolCall=" + JSON.stringify(event.toolCall).slice(0, 100));
  if (event.reason) parts.push("reason=" + event.reason);
  return parts.join("  ");
}

function assertContains(label: string, types: string[], ...expected: string[]) {
  for (const t of expected) {
    if (!types.includes(t)) {
      fail(label, "Missing expected event type: " + t + "\n  Got: " + types.join(", "));
    }
  }
}

function fail(label: string, msg: string): never {
  console.error("[FAIL] " + label + " - " + msg);
  process.exit(1);
}

// ── Run ──

async function main() {
  console.log("CLI integration test");
  console.log("Model: " + model.id);
  console.log("--------------------------------------------------");

  await testTextStreaming();
  await testOutputContent();
  await testThinkingBlocks();
  await testToolUseRawBridge();
  await testToolUseAgentBridge();
  console.log("=== All integration tests passed ===");
}

main().catch((err) => {
  console.error("\n[FAIL]", err);
  process.exit(1);
});
