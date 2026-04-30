import {
  Client
} from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readNow } from "@do-soul/alaya-core";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerInfo } from "@do-soul/alaya-protocol";

type DaemonMcpListedTool = {
  readonly name: string;
  readonly description: string;
};

export type DaemonMcpServerRuntimeConfig =
  | Readonly<{
      readonly transportType: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      readonly transportType: "http";
      readonly endpoint: string;
      readonly headers?: Readonly<Record<string, string>>;
    }>;

type DaemonMcpRuntimeClient = Pick<Client, "callTool" | "close" | "connect" | "listTools">;
type DaemonMcpRuntimeCallResult = Awaited<ReturnType<DaemonMcpRuntimeClient["callTool"]>>;
type DaemonMcpRuntimeTransport = (StdioClientTransport | StreamableHTTPClientTransport) & Readonly<{
  close?: () => Promise<void> | void;
}>;

type DaemonMcpRuntimeClientHandle = {
  readonly client: DaemonMcpRuntimeClient;
  readonly transport: DaemonMcpRuntimeTransport;
};

type WarnLogger = Readonly<{
  warn(message: string, meta: Record<string, unknown>): void;
}>;

type WarnPort = WarnLogger | ((message: string, meta: Record<string, unknown>) => void);

export interface DaemonMcpRuntimeRegistry {
  close(): Promise<void>;
  listServerInfos(): readonly Readonly<McpServerInfo>[];
  refresh(input?: {
    readonly serverNames?: readonly string[];
  }): Promise<void>;
  getServerTools(serverName: string): readonly DaemonMcpListedTool[];
  listServerTools(serverName: string): Promise<readonly DaemonMcpListedTool[]>;
  callTool(input: {
    readonly serverName: string;
    readonly toolName: string;
    readonly input: unknown;
  }): Promise< unknown>;
}

export function createDaemonMcpRuntimeRegistry(input: {
  readonly serverConfigs: Readonly<Record<string, DaemonMcpServerRuntimeConfig>>;
  readonly createClient?: () => DaemonMcpRuntimeClient;
  readonly createStdioTransport?: (
    params: StdioServerParameters
  ) => StdioClientTransport;
  readonly createStreamableHttpTransport?: (
    url: URL,
    options?: StreamableHTTPClientTransportOptions
  ) => StreamableHTTPClientTransport;
  readonly now?: () => string;
  readonly warn: WarnPort;
}): DaemonMcpRuntimeRegistry {
  const warn = resolveWarn(input.warn);
  const clientHandles = new Map<string, Promise<DaemonMcpRuntimeClientHandle>>();
  const toolCache = new Map<string, readonly DaemonMcpListedTool[]>();
  const liveServerNames = new Set<string>();
  let closePromise: Promise<void> | null = null;
  let closed = false;
  const serverInfos = Object.freeze(
    Object.entries(input.serverConfigs).map(([serverName, config]) =>
      createServerInfo(serverName, config, input.now)
    )
  );
  const serverInfoByName = new Map(
    serverInfos.map((server) => [server.server_name, server] as const)
  );

  return {
    async close() {
      if (closePromise !== null) {
        await closePromise;
        return;
      }

      closed = true;
      const pendingHandles = [...clientHandles.values()];
      closePromise = (async () => {
        const settledHandles = await Promise.allSettled(pendingHandles);
        await Promise.all(
          settledHandles.map(async (result) => {
            if (result.status !== "fulfilled") {
              return;
            }

            await closeHandle(result.value, warn);
          })
        );
        clientHandles.clear();
        toolCache.clear();
        liveServerNames.clear();
      })();
      await closePromise;
    },
    listServerInfos() {
      return Object.freeze(
        serverInfos.map((server) =>
          Object.freeze({
            ...server,
            status: liveServerNames.has(server.server_name) ? "active" : "inactive"
          })
        )
      );
    },
    async refresh(refreshInput) {
      if (closed) {
        return;
      }

      const targetServers = (refreshInput?.serverNames ?? serverInfos.map((server) => server.server_name))
        .map((serverName) => serverInfoByName.get(serverName))
        .filter((server): server is Readonly<McpServerInfo> => server !== undefined);

      await Promise.all(targetServers.map(async (server) => {
        try {
          await refreshServerTools(server.server_name);
        } catch (error) {
          warn("failed to refresh MCP server tool catalog", {
            serverName: server.server_name,
            error
          });
        }
      }));
    },
    getServerTools(serverName) {
      return readServerTools(serverName);
    },
    async listServerTools(serverName) {
      assertOpen();
      await refreshServerTools(serverName);
      return readServerTools(serverName);
    },
    async callTool({ serverName, toolName, input: rawInput }) {
      assertOpen();
      try {
        const handle = await getHandle(serverName);
        const result = await handle.client.callTool(
          {
            name: toolName,
            ...(isRecord(rawInput) ? { arguments: rawInput } : {})
          },
          CallToolResultSchema
        );
        liveServerNames.add(serverName);
        const content = readMcpToolResultContent(result);
        const structuredContent = readMcpToolStructuredContent(result);

        if (readMcpToolIsError(result)) {
          return {
            ok: false,
            code: "MCP_TOOL_ERROR",
            message: readMcpToolErrorMessage(content),
            content,
            ...(structuredContent === undefined ? {} : { structuredContent })
          };
        }

        return {
          content,
          ...(structuredContent === undefined ? {} : { structuredContent })
        };
      } catch (error) {
        await deactivateServer(serverName);
        throw error;
      }
    }
  };

  function assertOpen(): void {
    if (closed) {
      throw new Error("Daemon MCP runtime registry is closed.");
    }
  }

  async function getHandle(serverName: string): Promise<DaemonMcpRuntimeClientHandle> {
    assertOpen();
    const existing = clientHandles.get(serverName);
    if (existing !== undefined) {
      return await existing;
    }

    const config = input.serverConfigs[serverName];
    if (config === undefined) {
      throw new Error(`MCP server ${serverName} is not configured for daemon execution.`);
    }

    const pending = connectServer(config).catch((error) => {
      clientHandles.delete(serverName);
      throw error;
    });
    clientHandles.set(serverName, pending);
    return await pending;
  }

  async function connectServer(
    config: DaemonMcpServerRuntimeConfig
  ): Promise<DaemonMcpRuntimeClientHandle> {
    const client =
      input.createClient?.() ??
      new Client(
        {
          name: "do-soul-alaya-core-daemon",
          version: "0.0.1"
        },
        { capabilities: {} }
      );
    const transport: DaemonMcpRuntimeTransport =
      config.transportType === "stdio"
        ? (input.createStdioTransport ?? ((params) => new StdioClientTransport(params)))({
            command: config.command,
            ...(config.args === undefined ? {} : { args: [...config.args] }),
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            ...(config.env === undefined ? {} : { env: { ...config.env } }),
            stderr: "inherit"
          })
        : (input.createStreamableHttpTransport ??
            ((url, options) => new StreamableHTTPClientTransport(url, options)))(
            new URL(config.endpoint),
            config.headers === undefined
              ? undefined
              : { requestInit: { headers: { ...config.headers } } }
          );

    try {
      await client.connect(transport);
      return {
        client,
        transport
      };
    } catch (error) {
      await closeHandle(
        {
          client,
          transport
        },
        warn
      );
      throw error;
    }
  }

  async function refreshServerTools(serverName: string): Promise<void> {
    assertOpen();
    try {
      const handle = await getHandle(serverName);
      const listedTools = await handle.client.listTools();
      toolCache.set(
        serverName,
        Object.freeze(
          listedTools.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? `MCP tool ${tool.name}`
          }))
        )
      );
      liveServerNames.add(serverName);
    } catch (error) {
      await deactivateServer(serverName);
      throw error;
    }
  }

  function readServerTools(serverName: string): readonly DaemonMcpListedTool[] {
    if (!liveServerNames.has(serverName)) {
      return [];
    }

    return toolCache.get(serverName) ?? [];
  }

  async function deactivateServer(serverName: string): Promise<void> {
    liveServerNames.delete(serverName);
    toolCache.delete(serverName);
    const pendingHandle = clientHandles.get(serverName);

    if (pendingHandle === undefined) {
      return;
    }

    clientHandles.delete(serverName);
    const [result] = await Promise.allSettled([pendingHandle]);
    if (result?.status !== "fulfilled") {
      return;
    }

    await closeHandle(result.value, warn);
  }
}

function resolveWarn(warn: WarnPort | undefined): (message: string, meta: Record<string, unknown>) => void {
  if (typeof warn === "function") {
    return warn;
  }

  if (warn !== undefined) {
    return warn.warn.bind(warn);
  }

  throw new Error("createDaemonMcpRuntimeRegistry requires an explicit warn handler.");
}

async function closeHandle(
  handle: DaemonMcpRuntimeClientHandle,
  warn: (message: string, meta: Record<string, unknown>) => void
): Promise<void> {
  try {
    await handle.client.close();
  } catch (error) {
    warn("failed to close MCP runtime client", { error });
  }

  if (typeof handle.transport.close !== "function") {
    return;
  }

  try {
    await handle.transport.close();
  } catch (error) {
    warn("failed to close MCP runtime transport", { error });
  }
}

function createServerInfo(
  serverName: string,
  config: DaemonMcpServerRuntimeConfig,
  now?: () => string
): Readonly<McpServerInfo> {
  return Object.freeze({
    server_name: serverName,
    transport_type: config.transportType,
    ...(config.transportType === "http" ? { endpoint: config.endpoint } : {}),
    status: "inactive",
    registered_at: readNow(now)
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMcpToolResultContent(result: DaemonMcpRuntimeCallResult): unknown {
  if ("content" in result) {
    return result.content;
  }

  return result.toolResult;
}

function readMcpToolStructuredContent(result: DaemonMcpRuntimeCallResult): unknown {
  return "structuredContent" in result ? result.structuredContent : undefined;
}

function readMcpToolIsError(result: DaemonMcpRuntimeCallResult): boolean {
  return "isError" in result && result.isError === true;
}

function readMcpToolErrorMessage(content: unknown): string {
  if (!Array.isArray(content)) {
    return "MCP tool call failed.";
  }

  for (const item of content) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }

    const text = (item as { readonly text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text;
    }
  }

  return "MCP tool call failed.";
}
