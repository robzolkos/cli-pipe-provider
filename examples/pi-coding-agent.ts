/**
 * Use cli-pipe-provider as a provider for the pi coding agent SDK.
 *
 * This lets you run pi's coding agent (with its built-in read, write, edit,
 * and bash tools) using a local CLI like `claude` for the LLM calls instead
 * of a direct API connection.
 *
 * Install:
 *   cd examples && npm install
 *
 * Run:
 *   npx tsx pi-coding-agent.ts
 */
import { createCliPipeProvider } from "cli-pipe-provider";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

// 1. Create and register the cli-pipe provider
const pipe = createCliPipeProvider({
  command: "claude",
  bridgeEntryPoint: "/dev/null",
  mcpServerName: "unused",
});
pipe.register();

// 2. Create a model that routes through the CLI
const model = pipe.createModel({ modelId: "claude-sonnet-4-6" });

// 3. Set up auth — cli-pipe doesn't need a real API key (the local CLI
//    handles authentication), but the coding agent requires one to be set.
const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey("cli-pipe", "not-needed");
const modelRegistry = new ModelRegistry(authStorage);

// 4. Create an agent session with the cli-pipe model
const { session } = await createAgentSession({
  model,
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// 5. Subscribe to streaming text output
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

// 6. Send a prompt — the agent will use its built-in tools (read, write, edit, bash)
await session.prompt("What files are in the current directory?");

console.log("\n");
session.dispose();
