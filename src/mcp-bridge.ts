import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { McpBridgeOptions } from "./types.js";
import { typeboxToJsonSchema } from "./utils.js";

/**
 * Start an MCP stdio server that exposes the given tools.
 *
 * Called from a consumer's bridge entry script:
 *   import { serveMcpBridge } from "cli-pipe-provider";
 *   await serveMcpBridge(myTools, { serverName: "my-app" });
 *
 * The CLI spawns this process and discovers tools via the MCP protocol.
 */
export async function serveMcpBridge(
  tools: AgentTool[],
  options?: McpBridgeOptions,
): Promise<void> {
  const serverName = options?.serverName ?? "cli-pipe-provider";
  const serverVersion = options?.serverVersion ?? "0.1.0";

  // Build a lookup map
  const toolMap = new Map<string, AgentTool<any>>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  // Create MCP server
  const server = new Server(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {} } },
  );

  // Handle tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: typeboxToJsonSchema(tool.parameters),
      })),
    };
  });

  // Handle tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const callId = `mcp-${Date.now()}`;
      const result = await tool.execute(callId, args ?? {});
      return {
        content: result.content.map((c: any) => ({
          type: (c.type ?? "text") as "text",
          text: c.text ?? "",
        })),
        isError: false,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Tool error: ${err.message}` }],
        isError: true,
      };
    }
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`MCP bridge: serving ${tools.length} tools (${serverName})\n`);
}
