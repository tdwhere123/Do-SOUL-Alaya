import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve, sep, join } from "node:path";
import { URL } from "node:url";
import {
  type AssembleContextInput,
  type ExportBundleInput,
  type GetMemoryGraphInput,
  type GovernMemoryInput,
  type ImportBundleInput,
  type IngestEvidenceInput,
  type IngestMemoryInput,
  type ListAuditEventsInput,
  type ListMemoriesInput,
  type ListScopesInput,
  type ListSessionViolationsInput,
  type RecordMemoryIngestInput,
  type RecordMemoryUsageInput,
  type SensitivityPolicy,
  type SoulMemoryPublicApi,
  type StartMemorySessionInput
} from "../contracts/index.js";
import {
  createSoulMemoryRuntime,
  defaultDataPath,
  RuntimeError,
  type SoulMemoryRuntime
} from "../runtime/index.js";
import { StorageError } from "../storage/index.js";
import { getInspectorAsset } from "../inspector/assets.js";

export interface SoulMemoryHttpServerOptions {
  readonly runtime?: SoulMemoryPublicApi & { close?: () => void };
  readonly dataDir?: string;
  readonly dataPath?: string;
}

export interface SoulMemoryListenOptions extends SoulMemoryHttpServerOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface SoulMemoryListenResult {
  readonly server: Server;
  readonly url: string;
  readonly inspectorUrl: string;
  readonly dataPath: string;
}

export interface SoulMemoryHttpRouteRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

export interface SoulMemoryHttpRouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: unknown;
}

type JsonRecord = Record<string, unknown>;

export function resolveSoulMemoryDataPath(options: { dataDir?: string; dataPath?: string } = {}): string {
  if (options.dataPath !== undefined) {
    return options.dataPath;
  }
  if (options.dataDir !== undefined) {
    return join(options.dataDir, "soul-memory.db");
  }
  return defaultDataPath();
}

export function createRuntimeForDataPath(options: { dataDir?: string; dataPath?: string } = {}): SoulMemoryRuntime {
  return createSoulMemoryRuntime({ path: resolveSoulMemoryDataPath(options) });
}

export function createSoulMemoryHttpServer(options: SoulMemoryHttpServerOptions = {}): Server {
  const runtime = options.runtime ?? createRuntimeForDataPath(options);
  const ownsRuntime = options.runtime === undefined;
  const server = createServer((request, response) => {
    void handleSoulMemoryHttpRequest(request, response, runtime);
  });
  if (ownsRuntime) {
    server.once("close", () => runtime.close?.());
  }
  return server;
}

export async function listenSoulMemoryHttpServer(
  options: SoulMemoryListenOptions = {}
): Promise<SoulMemoryListenResult> {
  const server = createSoulMemoryHttpServer(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  return {
    server,
    url,
    inspectorUrl: `${url}/`,
    dataPath: resolveSoulMemoryDataPath(options)
  };
}

export async function handleSoulMemoryHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: SoulMemoryPublicApi
): Promise<void> {
  try {
    applyCommonHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const method = request.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? {} : await readJsonBody(request);
    const result = await dispatchSoulMemoryHttpRoute(runtime, {
      method,
      path: request.url ?? "/",
      body
    });
    response.writeHead(result.status, { "content-type": result.contentType });
    response.end(
      result.contentType.startsWith("application/json") ? JSON.stringify(result.body) : String(result.body)
    );
  } catch (error) {
    sendError(response, error);
  }
}

export async function dispatchSoulMemoryHttpRoute(
  runtime: SoulMemoryPublicApi,
  request: SoulMemoryHttpRouteRequest
): Promise<SoulMemoryHttpRouteResponse> {
  try {
    const requestUrl = new URL(request.path, "http://localhost");
    const asset =
      request.method === "GET" && isInspectorAssetPath(requestUrl.pathname)
        ? getInspectorAsset(requestUrl.pathname)
        : undefined;
    if (asset !== undefined) {
      return {
        status: 200,
        contentType: asset.contentType,
        body: asset.body
      };
    }
    const result = await routeRequest(runtime, request.method, pathSegments(requestUrl.pathname), requestUrl, request.body ?? {});
    if (result === undefined) {
      return {
        status: 404,
        contentType: "application/json; charset=utf-8",
        body: { error: { code: "NOT_FOUND", message: "Route not found." } }
      };
    }
    return {
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: result
    };
  } catch (error) {
    const { status, code, message } = httpError(error);
    return {
      status,
      contentType: "application/json; charset=utf-8",
      body: { error: { code, message } }
    };
  }
}

async function routeRequest(
  runtime: SoulMemoryPublicApi,
  method: string,
  segments: readonly string[],
  requestUrl: URL,
  body: unknown
): Promise<unknown | undefined> {
  if (method === "GET" && matches(segments, ["health"])) {
    return runtime.health();
  }
  if (method === "GET" && matches(segments, ["doctor"])) {
    return runtime.doctor();
  }

  if (segments[0] !== "api") {
    return undefined;
  }

  if (method === "GET" && matches(segments, ["api", "health"])) {
    return runtime.health();
  }
  if (method === "GET" && matches(segments, ["api", "doctor"])) {
    return runtime.doctor();
  }

  if (segments[1] !== "memory") {
    return undefined;
  }

  const memoryRoute = segments.slice(2);
  if (memoryRoute.length === 0 && method === "GET") {
    return runtime.health();
  }

  if (method === "GET" && matches(memoryRoute, ["health"])) {
    return runtime.health();
  }
  if (method === "GET" && matches(memoryRoute, ["doctor"])) {
    return runtime.doctor();
  }
  if (method === "GET" && matches(memoryRoute, ["storage"])) {
    return runtime.getStorageStatus();
  }

  if (matches(memoryRoute, ["memories"])) {
    if (method === "GET") {
      return runtime.listMemories(listMemoriesInputFromQuery(requestUrl));
    }
    if (method === "POST") {
      return runtime.ingestMemory(asIngestMemoryInput(body));
    }
  }

  if (memoryRoute[0] === "memories" && memoryRoute.length === 2 && method === "GET") {
    return runtime.getMemory({ memoryId: memoryRoute[1] ?? "" });
  }

  if (memoryRoute[0] === "memories" && memoryRoute.length === 3 && method === "POST") {
    return governMemory(runtime, memoryRoute[2] ?? "", memoryRoute[1] ?? "", body);
  }

  if (matches(memoryRoute, ["evidence"]) && method === "GET") {
    return runtime.listEvidence({ memoryId: optionalQueryString(requestUrl, "memoryId") });
  }
  if (matches(memoryRoute, ["evidence"]) && method === "POST") {
    return runtime.ingestEvidence(asRecord(body) as unknown as IngestEvidenceInput);
  }

  if (matches(memoryRoute, ["scopes"]) && method === "GET") {
    return runtime.listScopes(listScopesInputFromQuery(requestUrl));
  }

  if (matches(memoryRoute, ["ingest"]) && method === "POST") {
    return runtime.ingestMemory(asIngestMemoryInput(body));
  }

  if (matches(memoryRoute, ["recall"]) && method === "POST") {
    const record = asRecord(body);
    return runtime.recall({
      ...record,
      query: requiredStringField(record, "query")
    } as unknown as Parameters<SoulMemoryPublicApi["recall"]>[0]);
  }

  if (matches(memoryRoute, ["context"]) && method === "POST") {
    const record = asRecord(body);
    return runtime.assembleContext({
      ...record,
      query: requiredStringField(record, "query")
    } as unknown as AssembleContextInput);
  }

  if (matches(memoryRoute, ["graph"]) && method === "GET") {
    return runtime.getMemoryGraph(memoryGraphInputFromQuery(requestUrl));
  }

  if (matches(memoryRoute, ["audit-events"]) && method === "GET") {
    return (await runtime.listAuditEvents(listAuditEventsInputFromQuery(requestUrl))).auditEvents;
  }
  if (matches(memoryRoute, ["audit"]) && method === "GET") {
    return runtime.listAuditEvents(listAuditEventsInputFromQuery(requestUrl));
  }

  if (matches(memoryRoute, ["recall-exclusions"]) && method === "GET") {
    return recallExclusions(runtime, requestUrl);
  }

  if (memoryRoute[0] === "context-packs" && memoryRoute.length === 2 && method === "GET") {
    return (await runtime.getContextPack({ contextPackId: memoryRoute[1] ?? "" })).contextPack;
  }

  if (matches(memoryRoute, ["sessions"]) && method === "POST") {
    return runtime.startMemorySession(asRecord(body) as unknown as StartMemorySessionInput);
  }
  if (memoryRoute[0] === "sessions" && memoryRoute.length === 2 && method === "GET") {
    return runtime.getMemorySession(memoryRoute[1] ?? "");
  }
  if (memoryRoute[0] === "sessions" && memoryRoute.length === 3 && memoryRoute[2] === "graph" && method === "GET") {
    return runtime.getMemoryGraph({ ...memoryGraphInputFromQuery(requestUrl), sessionId: memoryRoute[1] ?? "" });
  }
  if (memoryRoute[0] === "sessions" && memoryRoute.length === 3 && memoryRoute[2] === "context" && method === "POST") {
    return runtime.assembleContextForSession(memoryRoute[1] ?? "", asRecord(body) as unknown as AssembleContextInput);
  }
  if (memoryRoute[0] === "sessions" && memoryRoute.length === 3 && memoryRoute[2] === "usage" && method === "POST") {
    return runtime.recordMemoryUsage(normalizeUsageInput(memoryRoute[1] ?? "", body));
  }
  if (memoryRoute[0] === "sessions" && memoryRoute.length === 3 && memoryRoute[2] === "ingest" && method === "POST") {
    return runtime.recordMemoryIngest(normalizeIngestEventInput(memoryRoute[1] ?? "", body));
  }
  if (memoryRoute[0] === "sessions" && memoryRoute.length === 3 && memoryRoute[2] === "finish" && method === "POST") {
    const record = asRecord(body);
    return runtime.finishMemorySession(memoryRoute[1] ?? "", {
      finishedAt: stringField(record, "finishedAt") ?? new Date().toISOString(),
      usageState: stringField(record, "usageState") ?? "unverifiable",
      ingestState: stringField(record, "ingestState") ?? "not-requested"
    } as Parameters<SoulMemoryPublicApi["finishMemorySession"]>[1]);
  }
  if (memoryRoute[0] === "sessions" && memoryRoute.length === 3 && memoryRoute[2] === "violations" && method === "GET") {
    return runtime.listSessionViolations(listSessionViolationsInputFromQuery(requestUrl, memoryRoute[1] ?? ""));
  }

  if (matches(memoryRoute, ["governance"]) && method === "POST") {
    const record = asRecord(body);
    return governMemory(runtime, stringField(record, "action") ?? "", stringField(record, "memoryId") ?? "", body);
  }

  if (matches(memoryRoute, ["export"]) && (method === "GET" || method === "POST")) {
    const input = method === "GET" ? exportBundleInputFromQuery(requestUrl) : asRecord(body);
    return runtime.exportBundle(input as unknown as ExportBundleInput);
  }
  if (matches(memoryRoute, ["import"]) && method === "POST") {
    return runtime.importBundle(asRecord(body) as unknown as ImportBundleInput);
  }
  if (matches(memoryRoute, ["backup"]) && method === "POST") {
    const record = asRecord(body);
    const path = requiredStringField(record, "path");
    await assertHttpBackupPath(runtime, path);
    return runtime.backup({ path });
  }

  return undefined;
}

async function governMemory(
  runtime: SoulMemoryPublicApi,
  action: string,
  memoryId: string,
  body: unknown
): Promise<unknown> {
  const record = asRecord(body);
  const input: GovernMemoryInput = {
    memoryId,
    actor: stringField(record, "actor") ?? "operator",
    reason: stringField(record, "reason") ?? "",
    evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs as GovernMemoryInput["evidenceRefs"] : undefined
  };
  if (action === "accept") {
    return runtime.acceptMemory(input);
  }
  if (action === "reject") {
    return runtime.rejectMemory(input);
  }
  if (action === "retire") {
    return runtime.retireMemory(input);
  }
  if (action === "mark-sensitive") {
    return runtime.markSensitive({ ...input, policy: sensitivityPolicyFromBody(record) });
  }
  throw new RuntimeError("VALIDATION_FAILED", `Unsupported governance action '${action}'.`);
}

async function recallExclusions(runtime: SoulMemoryPublicApi, requestUrl: URL): Promise<unknown[]> {
  const contextPackId = optionalQueryString(requestUrl, "contextPackId");
  if (contextPackId !== undefined) {
    return (await runtime.getContextPack({ contextPackId })).contextPack.excluded;
  }
  const query = optionalQueryString(requestUrl, "query") ?? optionalQueryString(requestUrl, "q");
  if (query !== undefined && query.length > 0) {
    return (await runtime.recall({ query })).exclusions;
  }
  return [];
}

function asIngestMemoryInput(body: unknown): IngestMemoryInput {
  const record = asRecord(body);
  if ("memory" in record) {
    if (!isJsonRecord(record.memory)) {
      throw new RuntimeError("VALIDATION_FAILED", "memory must be an object.");
    }
    if (record.evidence !== undefined && !Array.isArray(record.evidence)) {
      throw new RuntimeError("VALIDATION_FAILED", "evidence must be an array when provided.");
    }
    return record as unknown as IngestMemoryInput;
  }
  if (!isJsonRecord(record)) {
    throw new RuntimeError("VALIDATION_FAILED", "memory must be an object.");
  }
  return { memory: record as unknown as IngestMemoryInput["memory"] };
}

function normalizeUsageInput(sessionId: string, body: unknown): RecordMemoryUsageInput {
  const record = asRecord(body);
  const eventRecord = asRecord(record.event ?? record);
  return {
    event: {
      ...eventRecord,
      id: stringField(eventRecord, "id") ?? `usage:${Date.now()}`,
      sessionId,
      kind: stringField(eventRecord, "kind") ?? "usage-proof-unavailable",
      at: stringField(eventRecord, "at") ?? new Date().toISOString(),
      state: stringField(eventRecord, "state") ?? "unverifiable"
    } as RecordMemoryUsageInput["event"]
  };
}

function normalizeIngestEventInput(sessionId: string, body: unknown): RecordMemoryIngestInput {
  const record = asRecord(body);
  const eventRecord = asRecord(record.event ?? record);
  return {
    event: {
      ...eventRecord,
      id: stringField(eventRecord, "id") ?? `ingest:${Date.now()}`,
      sessionId,
      kind: stringField(eventRecord, "kind") ?? "ingest-skipped",
      at: stringField(eventRecord, "at") ?? new Date().toISOString(),
      state: stringField(eventRecord, "state") ?? "skipped"
    } as RecordMemoryIngestInput["event"]
  };
}

function listMemoriesInputFromQuery(requestUrl: URL): ListMemoriesInput {
  return {
    planes: optionalQueryList(requestUrl, "plane", "planes") as ListMemoriesInput["planes"],
    scopeIds: optionalQueryList(requestUrl, "scopeId", "scopeIds"),
    lifecycle: optionalQueryList(requestUrl, "lifecycle") as ListMemoriesInput["lifecycle"]
  };
}

function listScopesInputFromQuery(requestUrl: URL): ListScopesInput {
  return {
    planes: optionalQueryList(requestUrl, "plane", "planes") as ListScopesInput["planes"],
    kinds: optionalQueryList(requestUrl, "kind", "kinds") as ListScopesInput["kinds"]
  };
}

function listAuditEventsInputFromQuery(requestUrl: URL): ListAuditEventsInput {
  return {
    types: optionalQueryList(requestUrl, "type", "types") as ListAuditEventsInput["types"],
    targetId: optionalQueryString(requestUrl, "targetId"),
    since: optionalQueryString(requestUrl, "since"),
    until: optionalQueryString(requestUrl, "until")
  };
}

function listSessionViolationsInputFromQuery(requestUrl: URL, sessionId: string): ListSessionViolationsInput {
  return {
    sessionId,
    kinds: optionalQueryList(requestUrl, "kind", "kinds") as ListSessionViolationsInput["kinds"],
    unresolvedOnly: optionalBoolean(requestUrl, "unresolvedOnly")
  };
}

function memoryGraphInputFromQuery(requestUrl: URL): GetMemoryGraphInput {
  return {
    scopeIds: optionalQueryList(requestUrl, "scopeId", "scopeIds"),
    includeEvidence: optionalBoolean(requestUrl, "includeEvidence")
  };
}

function exportBundleInputFromQuery(requestUrl: URL): ExportBundleInput {
  return {
    planes: optionalQueryList(requestUrl, "plane", "planes") as ExportBundleInput["planes"],
    scopeIds: optionalQueryList(requestUrl, "scopeId", "scopeIds"),
    includeSessions: optionalBoolean(requestUrl, "includeSessions")
  };
}

function sensitivityPolicyFromBody(record: JsonRecord): SensitivityPolicy {
  const policy = asRecord(record.policy ?? {});
  const level = stringField(policy, "level");
  return {
    ...policy,
    level: level === "none" || level === "private" || level === "secret" ? level : "sensitive",
    reason: stringField(policy, "reason") ?? stringField(record, "reason")
  } as SensitivityPolicy;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (body.length > 4 * 1024 * 1024) {
      throw new RuntimeError("VALIDATION_FAILED", "Request body is too large.");
    }
  }
  if (body.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RuntimeError("VALIDATION_FAILED", "Request body must be valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, error: unknown): void {
  const { status, code, message } = httpError(error);
  sendJson(response, status, { error: { code, message } });
}

function httpError(error: unknown): { status: number; code: string; message: string } {
  const expected = error instanceof RuntimeError || error instanceof StorageError;
  const status =
    error instanceof RuntimeError && error.code === "NOT_FOUND"
      ? 404
      : expected
        ? 400
        : 500;
  const code = error instanceof RuntimeError || error instanceof StorageError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  return { status, code, message };
}

function applyCommonHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "http://localhost");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,accept");
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

function isInspectorAssetPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/inspector.css" ||
    pathname === "/inspector.js"
  );
}

function matches(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((segment, index) => segment === expected[index]);
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function requiredStringField(record: JsonRecord, key: string): string {
  const value = stringField(record, key);
  if (value === undefined || value.trim().length === 0) {
    throw new RuntimeError("VALIDATION_FAILED", `${key} is required.`);
  }
  return value;
}

async function assertHttpBackupPath(runtime: SoulMemoryPublicApi, targetPath: string): Promise<void> {
  const status = await runtime.getStorageStatus();
  if (status.location === undefined || status.location === ":memory:") {
    throw new RuntimeError("VALIDATION_FAILED", "HTTP backup requires file-backed storage.");
  }
  const storageDir = await realpath(resolve(dirname(status.location)));
  const target = resolve(targetPath);
  const targetParent = await nearestExistingParent(dirname(target));
  if (!isInsideDirectory(targetParent, storageDir)) {
    throw new RuntimeError(
      "VALIDATION_FAILED",
      `HTTP backup path must stay under storage directory ${storageDir}.`
    );
  }
  try {
    const targetStats = await lstat(target);
    if (targetStats.isSymbolicLink()) {
      throw new RuntimeError("VALIDATION_FAILED", "HTTP backup target must not be a symbolic link.");
    }
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  try {
    const existingTarget = await realpath(target);
    if (!isInsideDirectory(existingTarget, storageDir)) {
      throw new RuntimeError(
        "VALIDATION_FAILED",
        `HTTP backup path must stay under storage directory ${storageDir}.`
      );
    }
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new RuntimeError("VALIDATION_FAILED", `HTTP backup parent directory does not exist: ${path}.`);
      }
      current = parent;
    }
  }
}

function isInsideDirectory(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);
  return resolvedPath === resolvedDirectory || resolvedPath.startsWith(resolvedDirectory + sep);
}

function optionalQueryString(requestUrl: URL, key: string): string | undefined {
  const value = requestUrl.searchParams.get(key);
  return value === null || value.length === 0 ? undefined : value;
}

function optionalQueryList(requestUrl: URL, ...keys: readonly string[]): string[] | undefined {
  const values = keys.flatMap((key) => requestUrl.searchParams.getAll(key));
  const split = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  return split.length === 0 ? undefined : split;
}

function optionalBoolean(requestUrl: URL, key: string): boolean | undefined {
  const value = optionalQueryString(requestUrl, key);
  if (value === undefined) {
    return undefined;
  }
  return value === "1" || value === "true" || value === "yes";
}
