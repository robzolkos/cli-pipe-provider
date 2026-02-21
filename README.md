# cli-pipe-provider

A [pi-ai](https://github.com/badlogic/pi-mono) provider for CLI tools that produce `stream-json` output, with built-in MCP tool bridge support.

## Prerequisites

- A CLI that supports `-p --output-format stream-json` (pipe mode with JSON streaming)
- Node.js >= 20
- `@mariozechner/pi-ai` `^0.54.0` (peer dependency)

## Install

```bash
npm install cli-pipe-provider
```

## Usage

There are two modes: **simple streaming** (no tools) and **streaming with MCP tool bridge**.

### Simple streaming (no tools)

If you just need text/thinking streaming without tool use:

```ts
import { createCliPipeProvider } from "cli-pipe-provider";

const pipe = createCliPipeProvider({
  command: "claude",
  bridgeEntryPoint: "/dev/null",  // not used when tools are disabled
  mcpServerName: "unused",
});

pipe.register();

const model = pipe.createModel({ modelId: "claude-sonnet-4-6" });

const stream = pipe.stream(
  model,
  {
    systemPrompt: "You are a helpful assistant.",
    messages: [{ role: "user", content: "Hello!" }],
  },
  { enableTools: false },
);

for await (const event of stream) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  }
}
```

### Streaming with tool use

To give the CLI access to your tools, you need two files:

#### 1. Write a bridge entry script

This is a standalone Node.js file that the CLI spawns as an MCP server. It exposes your tools over the MCP protocol.

**Using `serveMcpBridge` with pi-ai agent tools:**

```ts
// bridge.ts
import { serveMcpBridge } from "cli-pipe-provider";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const tools: AgentTool[] = [
  {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: Type.Object({
      city: Type.String({ description: "City name" }),
    }),
    async execute(callId, args) {
      return {
        content: [{ type: "text", text: `Weather in ${args.city}: sunny, 22°C` }],
      };
    },
  },
];

await serveMcpBridge(tools, { serverName: "my-app" });
```

**Or using a raw MCP server with `@modelcontextprotocol/sdk`:**

```ts
// bridge.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "my-tools", version: "1.0.0" });

server.tool("get_weather", { city: { type: "string" } }, async ({ city }) => ({
  content: [{ type: "text", text: `Weather in ${city}: sunny, 22°C` }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
```

#### 2. Create the provider and stream

Point `bridgeEntryPoint` at the compiled bridge script:

```ts
import { createCliPipeProvider } from "cli-pipe-provider";

const pipe = createCliPipeProvider({
  command: "claude",
  bridgeEntryPoint: "/absolute/path/to/dist/bridge.js",
  mcpServerName: "my-app",
});

pipe.register();

const model = pipe.createModel({ modelId: "claude-sonnet-4-6" });

const stream = pipe.stream(
  model,
  {
    systemPrompt: "You have a get_weather tool. Use it to answer questions.",
    messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
  },
);

for await (const event of stream) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  }
  if (event.type === "toolcall_end") {
    console.log("\nTool called:", event.toolCall.name, event.toolCall.arguments);
  }
}
```

The provider writes a temporary MCP config, spawns the CLI with `--mcp-config`, and the CLI discovers and calls your tools during its agentic loop. The config is cleaned up automatically when the stream ends.

## Stream options

```ts
pipe.stream(model, context, {
  // Enable/disable MCP tool bridge (default: true)
  enableTools: true,

  // Thinking/reasoning level
  reasoning: "high",

  // Additional CLI args for the bridge script
  bridgeArgs: ["--verbose"],

  // Session ID for conversation continuity
  sessionId: "my-session",

  // Abort signal
  signal: controller.signal,
});
```

## Events emitted

| Event | Description |
|---|---|
| `start` | Stream opened, partial output available |
| `text_start` / `text_delta` / `text_end` | Text content streaming |
| `thinking_start` / `thinking_delta` / `thinking_end` | Reasoning/thinking blocks |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | Tool use blocks |
| `done` | Stream completed successfully |
| `error` | Stream ended with an error |

## API

### `createCliPipeProvider(options)`

Factory that returns a provider object with `register()`, `createModel()`, `stream()`, and `streamSimple()`.

```ts
const pipe = createCliPipeProvider({
  command: string;               // CLI binary to spawn
  bridgeEntryPoint: string;      // absolute path to compiled bridge script
  mcpServerName: string;         // used for --allowedTools glob
  bridgeArgs?: string[];         // default CLI args passed to bridge script
  resolveBridgeArgs?: (model) => string[];  // dynamic args from model metadata
});
```

Args are merged in order: `resolveBridgeArgs(model)` + provider `bridgeArgs` + per-stream `bridgeArgs`.

### `serveMcpBridge(tools, options?)`

Start an MCP stdio server that exposes the given `AgentTool[]` array. Called from your bridge entry script.

```ts
await serveMcpBridge(tools, {
  serverName: "my-app",       // default: "cli-pipe-provider"
  serverVersion: "1.0.0",     // default: "0.1.0"
});
```

### `checkCliAvailable(command)`

Check whether the CLI binary is installed and accessible.

```ts
import { checkCliAvailable } from "cli-pipe-provider";

const { available, version, error } = await checkCliAvailable("claude");
if (!available) {
  console.error("CLI not found:", error);
}
```

### `typeboxToJsonSchema(schema)`

Utility to convert a TypeBox schema to a clean JSON Schema object (strips TypeBox-internal symbols). Used internally by `serveMcpBridge` but exported for convenience.

## How it works

1. Registers a custom `cli-pipe` provider with pi-ai
2. On each `stream()` call, writes a temporary MCP config pointing at your bridge entry script
3. Spawns the CLI in pipe mode with `--output-format stream-json --mcp-config <config> --allowedTools "mcp__<name>__*"`
4. The CLI spawns your bridge script, discovers tools via MCP, and calls them during its agentic loop
5. Text, thinking, and tool-use events are parsed from stdout and emitted as standard pi-ai `AssistantMessageEvent`s
6. The temporary MCP config is cleaned up when the stream ends

## License

MIT
