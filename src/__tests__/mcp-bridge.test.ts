import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
/**
 * Integration test for serveMcpBridge with mock tools.
 *
 * We create a tiny bridge entry script on disk that:
 *   1. Imports serveMcpBridge from the built package
 *   2. Defines mock AgentTool[] inline
 *   3. Calls serveMcpBridge(tools)
 *
 * Then we spawn it and talk MCP protocol over stdio.
 */

const TEST_DIR = path.join(os.tmpdir(), `cpp-test-${Date.now()}`);
const BRIDGE_SCRIPT = path.join(TEST_DIR, "test-bridge.mjs");
const PACKAGE_DIST = path.join(import.meta.dirname, "../../dist/index.js");

function setupTestBridge() {
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Write a small workspace file for the echo tool to read
  const workspace = path.join(TEST_DIR, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "hello.txt"), "Hello from mock workspace!\n", "utf-8");

  // Write the bridge entry script
  // This simulates what a consumer would write — import serveMcpBridge + provide tools
  const script = `
import { serveMcpBridge } from ${JSON.stringify(PACKAGE_DIST)};
import * as fs from "node:fs";

const echoTool = {
  name: "echo",
  label: "Echo",
  description: "Echoes the input back",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to echo" },
    },
    required: ["message"],
  },
  async execute(callId, params) {
    return {
      content: [{ type: "text", text: "Echo: " + params.message }],
      details: {},
    };
  },
};

const readFileTool = {
  name: "read_file",
  label: "Read File",
  description: "Read a file from disk",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to read" },
    },
    required: ["path"],
  },
  async execute(callId, params) {
    const content = fs.readFileSync(params.path, "utf-8");
    return {
      content: [{ type: "text", text: content }],
      details: {},
    };
  },
};

const failTool = {
  name: "always_fail",
  label: "Always Fail",
  description: "Always throws an error",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute() {
    throw new Error("Intentional failure");
  },
};

await serveMcpBridge([echoTool, readFileTool, failTool], {
  serverName: "test-server",
  serverVersion: "1.0.0",
});
`;

  fs.writeFileSync(BRIDGE_SCRIPT, script, "utf-8");
  return TEST_DIR;
}

function spawnBridge(): ChildProcess {
  return spawn("node", [BRIDGE_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function sendJsonRpc(proc: ChildProcess, message: object): void {
  proc.stdin!.write(JSON.stringify(message) + "\n");
}

async function collectResponses(proc: ChildProcess, count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    let buffer = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout: got ${results.length}/${count} responses. Buffer: ${buffer}`));
    }, timeoutMs);

    proc.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          results.push(JSON.parse(line));
        } catch {
          // skip non-JSON lines
        }
        if (results.length >= count) {
          clearTimeout(timer);
          proc.kill();
          resolve(results);
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", () => {
      clearTimeout(timer);
      resolve(results);
    });
  });
}

async function initAndRequest(request: object): Promise<any[]> {
  const proc = spawnBridge();

  // MCP handshake
  sendJsonRpc(proc, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  });
  sendJsonRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
  sendJsonRpc(proc, request);

  return collectResponses(proc, 2);
}

describe("serveMcpBridge", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = setupTestBridge();
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("completes MCP handshake", async () => {
    const proc = spawnBridge();

    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    const responses = await collectResponses(proc, 1);
    expect(responses[0].result.serverInfo.name).toBe("test-server");
    expect(responses[0].result.capabilities.tools).toBeDefined();
  });

  it("lists tools", async () => {
    const responses = await initAndRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const toolsResponse = responses.find((r) => r.id === 2);
    expect(toolsResponse).toBeDefined();

    const toolNames = toolsResponse.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("echo");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("always_fail");
  });

  it("tools have proper JSON Schema input schemas", async () => {
    const responses = await initAndRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const toolsResponse = responses.find((r) => r.id === 2);
    const echoTool = toolsResponse.result.tools.find((t: any) => t.name === "echo");

    expect(echoTool.inputSchema.type).toBe("object");
    expect(echoTool.inputSchema.properties.message).toBeDefined();
    expect(echoTool.inputSchema.properties.message.type).toBe("string");
    expect(echoTool.inputSchema.required).toContain("message");
  });

  it("executes echo tool", async () => {
    const responses = await initAndRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hello world" } },
    });

    const callResponse = responses.find((r) => r.id === 3);
    expect(callResponse.result.isError).toBe(false);
    expect(callResponse.result.content[0].text).toBe("Echo: hello world");
  });

  it("executes read_file tool", async () => {
    const filePath = path.join(TEST_DIR, "workspace", "hello.txt");
    const responses = await initAndRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: filePath } },
    });

    const callResponse = responses.find((r) => r.id === 3);
    expect(callResponse.result.isError).toBe(false);
    expect(callResponse.result.content[0].text).toContain("Hello from mock workspace!");
  });

  it("returns error for tool that throws", async () => {
    const responses = await initAndRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "always_fail", arguments: {} },
    });

    const callResponse = responses.find((r) => r.id === 3);
    expect(callResponse.result.isError).toBe(true);
    expect(callResponse.result.content[0].text).toContain("Intentional failure");
  });

  it("returns error for unknown tool", async () => {
    const responses = await initAndRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });

    const callResponse = responses.find((r) => r.id === 3);
    expect(callResponse.result.isError).toBe(true);
    expect(callResponse.result.content[0].text).toContain("Unknown tool");
  });
});
