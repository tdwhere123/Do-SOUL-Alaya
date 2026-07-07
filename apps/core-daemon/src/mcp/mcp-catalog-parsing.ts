import {
  ToolProviderToolSpecSchema,
  type ToolProviderToolSpec
} from "@do-soul/alaya-protocol";
import { isBuiltinConversationToolId, type BuiltinConversationToolId } from "./builtin-conversation-tool-specs.js";
import type { DaemonMcpServerRuntimeConfig } from "./mcp-runtime-registry.js";

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
    const parsed = JSON.parse(rawValue) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object mapping server name -> runtime config");
    }

    const runtimeConfigs: Record<string, DaemonMcpServerRuntimeConfig> = {};
    for (const [serverName, rawConfig] of Object.entries(parsed as Record<string, unknown>)) {
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
  if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
    return null;
  }

  const candidate = rawConfig as Record<string, unknown>;
  const transportType = readNonEmptyString(candidate["transport_type"]);
  if (transportType === "stdio") {
    warn("dropping MCP stdio runtime config from environment", {
      serverName
    });
    return null;
  }

  if (transportType === "http") {
    const endpoint = readNonEmptyString(candidate["endpoint"]);
    if (endpoint === null) {
      warn("dropping MCP HTTP runtime config without endpoint", {
        serverName,
      });
      return null;
    }

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
      transportType,
      endpoint,
      ...(candidate["headers"] === undefined
        ? {}
        : { headers: readStringRecord(candidate["headers"]) })
    });
  }

  return null;
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
    const parsed = JSON.parse(rawValue) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object mapping server name -> tool array");
    }

    const byServer = new Map<string, readonly DaemonMcpCatalogToolEntry[]>();
    for (const [serverName, rawTools] of Object.entries(parsed as Record<string, unknown>)) {
      if (serverName.trim().length === 0 || !Array.isArray(rawTools)) {
        continue;
      }

      const parsedTools = rawTools
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
  if (typeof rawTool !== "object" || rawTool === null || Array.isArray(rawTool)) {
    return null;
  }

  const spec = parseMcpToolSpec(rawTool);
  if (spec === null) {
    return null;
  }

  const candidate = rawTool as Record<string, unknown>;
  return Object.freeze({
    spec,
    runtimeBinding: parseDaemonMcpToolRuntimeBinding(candidate["daemon_binding"])
  });
}

function parseMcpToolSpec(rawTool: unknown): Readonly<ToolProviderToolSpec> | null {
  if (typeof rawTool !== "object" || rawTool === null || Array.isArray(rawTool)) {
    return null;
  }

  const candidate = rawTool as Record<string, unknown>;
  try {
    return Object.freeze(
      ToolProviderToolSpecSchema.parse({
        tool_id: candidate["tool_id"],
        name: candidate["name"],
        description: candidate["description"]
      })
    );
  } catch (error) {
    // dropping an invalid tool spec is correct, but make the drop observable
    process.emitWarning("[McpCatalog] dropping invalid MCP tool spec", {
      code: "ALAYA_MCP_TOOL_SPEC_INVALID",
      detail: JSON.stringify({
        tool_id: typeof candidate["tool_id"] === "string" ? candidate["tool_id"] : null,
        name: typeof candidate["name"] === "string" ? candidate["name"] : null,
        error: error instanceof Error ? error.message : String(error)
      })
    });
    return null;
  }
}

function parseDaemonMcpToolRuntimeBinding(value: unknown): DaemonMcpRuntimeBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const bindingKind = readNonEmptyString(candidate["binding_kind"]);
  if (bindingKind === "builtin_tool") {
    const builtinToolId = readNonEmptyString(candidate["builtin_tool_id"]);
    if (!isBuiltinConversationToolId(builtinToolId)) {
      return null;
    }

    return Object.freeze({
      bindingKind,
      builtinToolId
    });
  }

  if (bindingKind === "mcp_tool") {
    const toolName = readNonEmptyString(candidate["tool_name"]);
    return Object.freeze({
      bindingKind,
      ...(toolName === null ? {} : { toolName })
    });
  }

  return null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  return Object.freeze(
    value.filter((item): item is string => typeof item === "string" && item.length > 0)
  );
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
