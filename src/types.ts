import type {
  Api,
  Model,
  StreamOptions,
  ThinkingLevel,
} from "@mariozechner/pi-ai";

// ─── Provider Options ───

export interface CliPipeProviderOptions {
  /** CLI binary to spawn (e.g. "claude") */
  command: string;
  /** Absolute path to the bridge entry script (the file that calls serveMcpBridge()) */
  bridgeEntryPoint: string;
  /** MCP server name — used for --allowedTools glob (e.g. "mcp__<name>__*") */
  mcpServerName: string;
  /** Default CLI args passed to the bridge script */
  bridgeArgs?: string[];
  /**
   * Optional callback to resolve bridge args from the model at stream time.
   * Useful when bridge args depend on metadata attached to the model object.
   * Returned args are prepended before bridgeArgs from provider and stream options.
   */
  resolveBridgeArgs?: (model: Model<Api>) => string[];
}

// ─── Stream Options ───

export interface CliPipeStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  /** CLI args passed to the bridge script (merged with provider defaults) */
  bridgeArgs?: string[];
  /** Whether to enable MCP tool bridge (default: true) */
  enableTools?: boolean;
}

// ─── MCP Bridge Options ───

export interface McpBridgeOptions {
  /** Server name reported during MCP handshake */
  serverName?: string;
  /** Server version reported during MCP handshake */
  serverVersion?: string;
}

// ─── MCP Config Shape ───

export interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args: string[];
  }>;
}

// ─── Provider Return ───

export interface CliPipeProvider {
  /** The custom API identifier */
  api: Api;
  /** The stream function for full options */
  stream: (model: Model<Api>, context: any, options?: CliPipeStreamOptions) => any;
  /** The stream function for simple options */
  streamSimple: (model: Model<Api>, context: any, options?: any) => any;
  /** Register this provider with pi-ai */
  register: () => void;
  /** Create a model instance for this provider */
  createModel: (opts?: { modelId?: string }) => Model<Api>;
}

// ─── Stream event types from CLI pipe mode --output-format stream-json ───

export interface CliSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
}

export type CliContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "thinking"; thinking: string };

export interface CliAssistantEvent {
  type: "assistant";
  message: {
    content: CliContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  session_id: string;
}

export interface CliResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export type CliStreamEvent =
  | CliSystemEvent
  | CliAssistantEvent
  | CliResultEvent
  | { type: string; [key: string]: unknown };
