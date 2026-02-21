import { spawn } from "node:child_process";
import type { Usage } from "@mariozechner/pi-ai";

/**
 * Check whether the CLI is available on the system.
 */
export async function checkCliAvailable(command: string): Promise<{ available: boolean; version?: string; error?: string }> {
  const env = { ...process.env };
  delete env.CLAUDECODE; // runtime env var set by the CLI

  return new Promise((resolve) => {
    const proc = spawn(command, ["--version"], { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("error", () => {
      resolve({ available: false, error: "CLI not found" });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ available: true, version: stdout.trim() });
      } else {
        resolve({ available: false, error: stderr.trim() || "CLI --version check failed" });
      }
    });
  });
}

/**
 * Convert a TypeBox schema to a clean JSON Schema object for MCP.
 * TypeBox schemas ARE JSON Schema — we just strip internal TypeBox symbols.
 */
export function typeboxToJsonSchema(typeboxSchema: any): Record<string, unknown> {
  const { type, properties, required, description } = typeboxSchema;
  const schema: Record<string, unknown> = { type };

  if (properties) {
    const cleanProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(properties)) {
      const prop = val as any;
      const clean: Record<string, unknown> = {};
      if (prop.type) clean.type = prop.type;
      if (prop.description) clean.description = prop.description;
      if (prop.enum) clean.enum = prop.enum;
      if (prop.default !== undefined) clean.default = prop.default;
      if (prop.anyOf) clean.anyOf = prop.anyOf;
      if (prop.items) clean.items = prop.items;
      cleanProps[key] = clean;
    }
    schema.properties = cleanProps;
  }

  if (required) schema.required = required;
  if (description) schema.description = description;

  return schema;
}

/**
 * Create an empty Usage object.
 */
export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Parse raw token usage from CLI stream-json events into a pi-ai Usage object.
 */
export function parseUsageFromRaw(raw?: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): Usage {
  if (!raw) return emptyUsage();
  const input = raw.input_tokens ?? 0;
  const output = raw.output_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Extract text from a content array or string.
 */
export function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }
  return "";
}
