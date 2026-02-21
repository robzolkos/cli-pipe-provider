/**
 * Pi Extension: cli-pipe provider
 *
 * Registers cli-pipe as a provider in the pi coding agent CLI, letting you
 * use models through a local CLI (like `claude`) that supports
 * `-p --output-format stream-json`.
 *
 * Install as a pi package:
 *   pi install git:github.com/robzolkos/cli-pipe-provider
 *
 * Or try without installing:
 *   pi -e git:github.com/robzolkos/cli-pipe-provider
 *
 * Then use /model to select cli-pipe/claude-sonnet-4-6
 */
import { createCliPipeProvider } from "../dist/index.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const pipe = createCliPipeProvider({
    command: "claude",
    bridgeEntryPoint: "/dev/null",
    mcpServerName: "unused",
  });

  // Wrap streamSimple to:
  // 1. Disable the MCP tool bridge — pi manages its own tools
  // 2. Strip sessionId — each stream() call is stateless (history is in stdin),
  //    and reusing a session ID causes "already in use" errors
  const streamSimple: typeof pipe.streamSimple = (model, context, options) => {
    const { sessionId, ...rest } = options ?? {} as any;
    return pipe.stream(model, context, { ...rest, enableTools: false });
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
