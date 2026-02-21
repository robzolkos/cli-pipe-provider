/**
 * Pi Extension: cli-pipe provider
 *
 * Registers cli-pipe as a provider in the pi coding agent CLI, letting you
 * use models through a local CLI (like `claude`) that supports
 * `-p --output-format stream-json`.
 *
 * Install:
 *   cd examples && npm install
 *
 * Usage:
 *   pi -e /path/to/cli-pipe-provider/examples/pi-extension.ts
 *   # Then /model and select cli-pipe/claude-sonnet-4-6
 */
import { createCliPipeProvider } from "cli-pipe-provider";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const pipe = createCliPipeProvider({
    command: "claude",
    bridgeEntryPoint: "/dev/null",
    mcpServerName: "unused",
  });

  // Wrap streamSimple to always disable the MCP tool bridge.
  // Pi's coding agent manages its own tools (read, write, edit, bash) —
  // the CLI is only used for LLM inference, not tool execution.
  const streamSimple: typeof pipe.streamSimple = (model, context, options) => {
    return pipe.stream(model, context, { ...options, enableTools: false });
  };

  pi.registerProvider("cli-pipe", {
    baseUrl: "local",
    api: "cli-pipe",
    apiKey: "not-needed",
    models: [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (via CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6 (via CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
    ],
    streamSimple,
  });
}
