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
import { readRuntimeVersion } from "../runtime/build-info.js";

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

type DaemonMcpRuntimeClientInfo = Readonly<{
  readonly name: "do-soul-alaya-core-daemon";
  readonly version: string;
}>;

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

export function createDaemonMcpRuntimeClientInfo(): DaemonMcpRuntimeClientInfo {
  return Object.freeze({
    name: "do-soul-alaya-core-daemon",
    version: readRuntimeVersion()
  });
}

type DaemonMcpRuntimeRegistryInput = {
  readonly serverConfigs: Readonly<Record<string, DaemonMcpServerRuntimeConfig>>;
  readonly createClient?: (clientInfo: DaemonMcpRuntimeClientInfo) => DaemonMcpRuntimeClient;
  readonly createStdioTransport?: (
    params: StdioServerParameters
  ) => StdioClientTransport;
  readonly createStreamableHttpTransport?: (
    url: URL,
    options?: StreamableHTTPClientTransportOptions
  ) => StreamableHTTPClientTransport;
  readonly now?: () => string;
  readonly warn: WarnPort;
};

type DaemonMcpRuntimeRegistryState = {
  readonly input: DaemonMcpRuntimeRegistryInput;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly clientInfo: DaemonMcpRuntimeClientInfo;
  readonly clientHandles: Map<string, Promise<DaemonMcpRuntimeClientHandle>>;
  readonly toolCache: Map<string, readonly DaemonMcpListedTool[]>;
  readonly liveServerNames: Set<string>;
  closePromise: Promise<void> | null;
  closed: boolean;
  readonly serverInfos: readonly Readonly<McpServerInfo>[];
  readonly serverInfoByName: Map<string, Readonly<McpServerInfo>>;
};

export function createDaemonMcpRuntimeRegistry(input: DaemonMcpRuntimeRegistryInput): DaemonMcpRuntimeRegistry {
  const state = createDaemonMcpRuntimeRegistryState(input);
  return {
    close: () => closeRegistry(state),
    listServerInfos: () => listServerInfos(state),
    refresh: (refreshInput) => refreshRegistry(state, refreshInput),
    getServerTools: (serverName) => readServerTools(state, serverName),
    listServerTools: (serverName) => listServerTools(state, serverName),
    callTool: (callInput) => callRuntimeTool(state, callInput)
  };
}

function createDaemonMcpRuntimeRegistryState(input: DaemonMcpRuntimeRegistryInput): DaemonMcpRuntimeRegistryState {
  const serverInfos = Object.freeze(
    Object.entries(input.serverConfigs).map(([serverName, config]) =>
      createServerInfo(serverName, config, input.now)
    )
  );
  return {
    input,
    warn: resolveWarn(input.warn),
    clientInfo: createDaemonMcpRuntimeClientInfo(),
    clientHandles: new Map(),
    toolCache: new Map(),
    liveServerNames: new Set(),
    closePromise: null,
    closed: false,
    serverInfos,
    serverInfoByName: new Map(serverInfos.map((server) => [server.server_name, server] as const))
  };
}

async function closeRegistry(state: DaemonMcpRuntimeRegistryState): Promise<void> {
  if (state.closePromise !== null) {
    await state.closePromise;
    return;
  }
  state.closed = true;
  const pendingHandles = [...state.clientHandles.values()];
  state.closePromise = closePendingHandles(state, pendingHandles);
  await state.closePromise;
}

async function closePendingHandles(
  state: DaemonMcpRuntimeRegistryState,
  pendingHandles: readonly Promise<DaemonMcpRuntimeClientHandle>[]
): Promise<void> {
  const settledHandles = await Promise.allSettled(pendingHandles);
  await Promise.all(settledHandles.map(async (result) => {
    if (result.status === "fulfilled") await closeHandle(result.value, state.warn);
  }));
  state.clientHandles.clear();
  state.toolCache.clear();
  state.liveServerNames.clear();
}

function listServerInfos(state: DaemonMcpRuntimeRegistryState): readonly Readonly<McpServerInfo>[] {
  return Object.freeze(
    state.serverInfos.map((server) =>
      Object.freeze({
        ...server,
        status: state.liveServerNames.has(server.server_name) ? "active" : "inactive"
      })
    )
  );
}

async function refreshRegistry(
  state: DaemonMcpRuntimeRegistryState,
  refreshInput?: { readonly serverNames?: readonly string[] }
): Promise<void> {
  if (state.closed) return;
  await Promise.all(resolveRefreshTargets(state, refreshInput).map(async (server) => {
    try {
      await refreshServerTools(state, server.server_name);
    } catch (error) {
      state.warn("failed to refresh MCP server tool catalog", { serverName: server.server_name, error });
    }
  }));
}

function resolveRefreshTargets(
  state: DaemonMcpRuntimeRegistryState,
  refreshInput?: { readonly serverNames?: readonly string[] }
): readonly Readonly<McpServerInfo>[] {
  return (refreshInput?.serverNames ?? state.serverInfos.map((server) => server.server_name))
    .map((serverName) => state.serverInfoByName.get(serverName))
    .filter((server): server is Readonly<McpServerInfo> => server !== undefined);
}

async function listServerTools(
  state: DaemonMcpRuntimeRegistryState,
  serverName: string
): Promise<readonly DaemonMcpListedTool[]> {
  assertOpen(state);
  await refreshServerTools(state, serverName);
  return readServerTools(state, serverName);
}

async function callRuntimeTool(
  state: DaemonMcpRuntimeRegistryState,
  input: { readonly serverName: string; readonly toolName: string; readonly input: unknown }
): Promise<unknown> {
  assertOpen(state);
  try {
    const handle = await getHandle(state, input.serverName);
    const result = await handle.client.callTool(
      { name: input.toolName, ...(isRecord(input.input) ? { arguments: input.input } : {}) },
      CallToolResultSchema
    );
    state.liveServerNames.add(input.serverName);
    return formatMcpToolResult(result);
  } catch (error) {
    await deactivateServer(state, input.serverName);
    throw error;
  }
}

function assertOpen(state: DaemonMcpRuntimeRegistryState): void {
  if (state.closed) throw new Error("Daemon MCP runtime registry is closed.");
}

async function getHandle(
  state: DaemonMcpRuntimeRegistryState,
  serverName: string
): Promise<DaemonMcpRuntimeClientHandle> {
  assertOpen(state);
  const existing = state.clientHandles.get(serverName);
  if (existing !== undefined) return await existing;
  const config = state.input.serverConfigs[serverName];
  if (config === undefined) throw new Error(`MCP server ${serverName} is not configured for daemon execution.`);
  const pending = connectServer(state, config).catch((error) => {
    state.clientHandles.delete(serverName);
    throw error;
  });
  state.clientHandles.set(serverName, pending);
  return await pending;
}

async function connectServer(
  state: DaemonMcpRuntimeRegistryState,
  config: DaemonMcpServerRuntimeConfig
): Promise<DaemonMcpRuntimeClientHandle> {
  const client = state.input.createClient?.(state.clientInfo) ?? new Client(state.clientInfo, { capabilities: {} });
  const transport = createRuntimeTransport(state, config);
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    await closeHandle({ client, transport }, state.warn);
    throw error;
  }
}

function createRuntimeTransport(
  state: DaemonMcpRuntimeRegistryState,
  config: DaemonMcpServerRuntimeConfig
): DaemonMcpRuntimeTransport {
  return config.transportType === "stdio"
    ? createStdioRuntimeTransport(state, config)
    : createHttpRuntimeTransport(state, config);
}

function createStdioRuntimeTransport(
  state: DaemonMcpRuntimeRegistryState,
  config: Extract<DaemonMcpServerRuntimeConfig, { readonly transportType: "stdio" }>
): StdioClientTransport {
  return (state.input.createStdioTransport ?? ((params) => new StdioClientTransport(params)))({
    command: config.command,
    ...(config.args === undefined ? {} : { args: [...config.args] }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.env === undefined ? {} : { env: { ...config.env } }),
    stderr: "inherit"
  });
}

function createHttpRuntimeTransport(
  state: DaemonMcpRuntimeRegistryState,
  config: Extract<DaemonMcpServerRuntimeConfig, { readonly transportType: "http" }>
): StreamableHTTPClientTransport {
  const options = config.headers === undefined
    ? undefined
    : { requestInit: { headers: { ...config.headers } } };
  return (state.input.createStreamableHttpTransport ??
    ((url, transportOptions) => new StreamableHTTPClientTransport(url, transportOptions)))(
    new URL(config.endpoint),
    options
  );
}

async function refreshServerTools(state: DaemonMcpRuntimeRegistryState, serverName: string): Promise<void> {
  assertOpen(state);
  try {
    const handle = await getHandle(state, serverName);
    const listedTools = await handle.client.listTools();
    state.toolCache.set(serverName, Object.freeze(listedTools.tools.map(toListedTool)));
    state.liveServerNames.add(serverName);
  } catch (error) {
    await deactivateServer(state, serverName);
    throw error;
  }
}

function toListedTool(tool: { readonly name: string; readonly description?: string }): DaemonMcpListedTool {
  return {
    name: tool.name,
    description: tool.description ?? `MCP tool ${tool.name}`
  };
}

function readServerTools(
  state: DaemonMcpRuntimeRegistryState,
  serverName: string
): readonly DaemonMcpListedTool[] {
  return state.liveServerNames.has(serverName) ? state.toolCache.get(serverName) ?? [] : [];
}

async function deactivateServer(state: DaemonMcpRuntimeRegistryState, serverName: string): Promise<void> {
  state.liveServerNames.delete(serverName);
  state.toolCache.delete(serverName);
  const pendingHandle = state.clientHandles.get(serverName);
  if (pendingHandle === undefined) return;
  state.clientHandles.delete(serverName);
  const [result] = await Promise.allSettled([pendingHandle]);
  if (result?.status === "fulfilled") await closeHandle(result.value, state.warn);
}

function formatMcpToolResult(result: DaemonMcpRuntimeCallResult): unknown {
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
  return { content, ...(structuredContent === undefined ? {} : { structuredContent }) };
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
