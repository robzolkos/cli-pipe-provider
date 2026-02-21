/**
 * AgentTool bridge — uses serveMcpBridge() with a real AgentTool.
 * Exposes a `get_weather` tool for integration testing.
 *
 * Uses the built dist/ output so it can run with plain `node`.
 */
import { Type } from "@sinclair/typebox";
import { serveMcpBridge } from "../../dist/mcp-bridge.js";

const weatherTool = {
  name: "get_weather",
  label: "Get Weather",
  description: "Get the current weather for a city. Always returns sunny 72F for testing.",
  parameters: Type.Object({
    city: Type.String({ description: "City name" }),
  }),
  async execute(_callId, params) {
    const city = params.city ?? "unknown";
    return {
      content: [{ type: "text", text: `Weather in ${city}: Sunny, 72°F` }],
      details: { city, temp: 72 },
    };
  },
};

await serveMcpBridge([weatherTool], { serverName: "test-agent-tool" });
