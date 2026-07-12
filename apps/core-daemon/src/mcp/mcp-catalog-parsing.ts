import {
  ToolProviderToolSpecSchema,
  type ToolProviderToolSpec
} from "@do-soul/alaya-protocol";
import { z } from "zod";
import { isBuiltinConversationToolId, type BuiltinConversationToolId } from "./builtin-conversation-tool-specs.js";
import type { DaemonMcpServerRuntimeConfig } from "./mcp-runtime-registry.js";

const JsonObjectRecordSchema = z.record(z.string(), z.unknown());
const NonEmptyStringSchema = z.string().trim().min(1);
const McpToolCatalogServerToolsSchema = z.array(z.unknown());
const McpToolEntryInputSchema = z
  .object({
    tool_id: z.unknown(),
    name: z.unknown(),
    description: z.unknown(),
    daemon_binding: z.unknown().optional()
  })
  .loose()
  .readonly();
const DaemonMcpHttpConfigInputSchema = z
  .object({
    transport_type: z.literal("http"),
    endpoint: NonEmptyStringSchema,
    headers: z.unknown().optional()
  })
  .readonly();
const DaemonMcpStdioConfigInputSchema = z
  .object({
    transport_type: z.literal("stdio")
  })
  .loose()
  .readonly();
const DaemonMcpBindingBuiltinSchema = z
  .object({
    binding_kind: z.literal("builtin_tool"),
    builtin_tool_id: NonEmptyStringSchema
  })
  .readonly();
const DaemonMcpBindingMcpToolSchema = z
  .object({
    binding_kind: z.literal("mcp_tool"),
    tool_name: NonEmptyStringSchema.optional()
  })
  .readonly();

export type DaemonMcpRuntimeBinding = Readonly<{
  readonly bindingKind: "builtin_tool";
  readonly builtinToolId: BuiltinConversationToolId;
}> | Readonly<{
  readonly bindingKind: "mcp_tool";
  readonly toolName?: string;
}>;

export type DaemonMcpCatalogToolEntry = Readonly<{
  readonly spec: Readonly<ToolProviderToolSpec>;
  readonly runtimeBinding: DaemonMcpRuntimeBinding | null;
}>;

export type WarnLogger = (message: string, meta: Record<string, unknown>) => void;
export type EnvLookup = Readonly<Record<string, string | undefined>>;
export type DaemonMcpCatalogEnvironmentSnapshot = Readonly<{
  readonly allowedServerNames: readonly string[];
  readonly rawToolCatalog: ReadonlyMap<string, readonly DaemonMcpCatalogToolEntry[]>;
}>;

export function parseDaemonMcpServerRuntimeConfigs(
  rawValue: string | undefined,
  warn: WarnLogger = defaultWarn
): Readonly<Record<string, DaemonMcpServerRuntimeConfig>> {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return Object.freeze({});
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);
    const envelope = JsonObjectRecordSchema.parse(parsed);

    const runtimeConfigs: Record<string, DaemonMcpServerRuntimeConfig> = {};
    for (const [serverName, rawConfig] of Object.entries(envelope)) {
      const config = parseDaemonMcpServerRuntimeConfig(serverName, rawConfig, warn);
      if (config !== null) {
        runtimeConfigs[serverName] = config;
      }
    }

    return Object.freeze(runtimeConfigs);
  } catch (error) {
    warn("failed to parse ALAYA_MCP_SERVER_CONFIG_JSON; ignoring MCP runtime config", {
      error
    });
    return Object.freeze({});
  }
}

export function parseAllowedMcpServerNames(rawValue: string | undefined): readonly string[] {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return [];
  }

  return dedupeStrings(
    rawValue
      .split(",")
      .map((serverName) => serverName.trim())
      .filter((serverName) => serverName.length > 0)
  );
}

export function readDaemonMcpCatalogEnvironment(
  env: EnvLookup,
  warn: WarnLogger
): DaemonMcpCatalogEnvironmentSnapshot {
  return Object.freeze({
    allowedServerNames: parseAllowedMcpServerNames(env.ALAYA_ALLOWED_MCP_SERVERS),
    rawToolCatalog: parseMcpToolCatalogByServer(env.ALAYA_MCP_TOOL_CATALOG_JSON, warn)
  });
}

export function defaultWarn(message: string, meta: Record<string, unknown>): void {
  console.warn(message, meta);
}

function parseDaemonMcpServerRuntimeConfig(
  serverName: string,
  rawConfig: unknown,
  warn: WarnLogger
): DaemonMcpServerRuntimeConfig | null {
  if (DaemonMcpStdioConfigInputSchema.safeParse(rawConfig).success) {
    warn("dropping MCP stdio runtime config from environment", {
      serverName
    });
    return null;
  }

  const httpConfig = DaemonMcpHttpConfigInputSchema.safeParse(rawConfig);
  if (!httpConfig.success) {
    return null;
  }

  const endpoint = httpConfig.data.endpoint;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (!isLoopbackMcpEndpoint(url)) {
      warn("dropping MCP HTTP runtime config with non-local endpoint", {
        serverName,
        endpoint
      });
      return null;
    }
  } catch {
    warn("dropping MCP HTTP runtime config with invalid endpoint", {
      serverName,
      endpoint
    });
    return null;
  }

  return Object.freeze({
    transportType: "http",
    endpoint,
    ...(httpConfig.data.headers === undefined
      ? {}
      : { headers: readStringRecord(httpConfig.data.headers) })
  });
}

function isLoopbackMcpEndpoint(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") {
    return true;
  }
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => {
      if (!/^\d+$/.test(part)) {
        return false;
      }
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

function parseMcpToolCatalogByServer(
  rawValue: string | undefined,
  warn: WarnLogger = defaultWarn
): ReadonlyMap<string, readonly DaemonMcpCatalogToolEntry[]> {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return new Map<string, readonly DaemonMcpCatalogToolEntry[]>();
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);
    const envelope = JsonObjectRecordSchema.parse(parsed);

    const byServer = new Map<string, readonly DaemonMcpCatalogToolEntry[]>();
    for (const [serverName, rawTools] of Object.entries(envelope)) {
      if (serverName.trim().length === 0) {
        continue;
      }
      const tools = McpToolCatalogServerToolsSchema.safeParse(rawTools);
      if (!tools.success) {
        continue;
      }

      const parsedTools = tools.data
        .map((rawTool) => parseMcpToolEntry(rawTool))
        .filter((tool): tool is DaemonMcpCatalogToolEntry => tool !== null);
      byServer.set(serverName, Object.freeze(parsedTools));
    }

    return byServer;
  } catch (error) {
    warn("failed to parse ALAYA_MCP_TOOL_CATALOG_JSON; ignoring MCP discovery catalog", {
      error
    });
    return new Map<string, readonly DaemonMcpCatalogToolEntry[]>();
  }
}

function parseMcpToolEntry(rawTool: unknown): DaemonMcpCatalogToolEntry | null {
  const candidate = McpToolEntryInputSchema.safeParse(rawTool);
  if (!candidate.success) {
    return null;
  }

  const spec = parseMcpToolSpec(candidate.data);
  if (spec === null) {
    return null;
  }

  return Object.freeze({
    spec,
    runtimeBinding: parseDaemonMcpToolRuntimeBinding(candidate.data.daemon_binding)
  });
}

function parseMcpToolSpec(rawTool: Pick<z.infer<typeof McpToolEntryInputSchema>, "tool_id" | "name" | "description">): Readonly<ToolProviderToolSpec> | null {
  try {
    return Object.freeze(
      ToolProviderToolSpecSchema.parse({
        tool_id: rawTool.tool_id,
        name: rawTool.name,
        description: rawTool.description
      })
    );
  } catch (error) {
    // dropping an invalid tool spec is correct, but make the drop observable
    process.emitWarning("[McpCatalog] dropping invalid MCP tool spec", {
      code: "ALAYA_MCP_TOOL_SPEC_INVALID",
      detail: JSON.stringify({
        tool_id: typeof rawTool.tool_id === "string" ? rawTool.tool_id : null,
        name: typeof rawTool.name === "string" ? rawTool.name : null,
        error: error instanceof Error ? error.message : String(error)
      })
    });
    return null;
  }
}

function parseDaemonMcpToolRuntimeBinding(value: unknown): DaemonMcpRuntimeBinding | null {
  const builtinBinding = DaemonMcpBindingBuiltinSchema.safeParse(value);
  if (builtinBinding.success) {
    if (!isBuiltinConversationToolId(builtinBinding.data.builtin_tool_id)) {
      return null;
    }

    return Object.freeze({
      bindingKind: "builtin_tool",
      builtinToolId: builtinBinding.data.builtin_tool_id
    });
  }

  const mcpToolBinding = DaemonMcpBindingMcpToolSchema.safeParse(value);
  if (mcpToolBinding.success) {
    return Object.freeze({
      bindingKind: "mcp_tool",
      ...(mcpToolBinding.data.tool_name === undefined
        ? {}
        : { toolName: mcpToolBinding.data.tool_name })
    });
  }

  return null;
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({});
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === "string"
      )
    )
  );
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}
