import { parentPort } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import {
  applySqliteWritePragmas,
  applySqliteWriteQueueSessionPragmas,
  isSqliteWriteQueueSessionPragmas,
  type SqliteWriteQueueSessionPragmas
} from "../apply-sqlite-write-pragmas.js";
import type {
  SqliteWriteQueueWorkerRequest,
  SqliteWriteQueueWorkerResponse
} from "./worker-protocol.js";
import type { SqliteWriteJobKind, SqliteWriteStatement } from "./port.js";

if (parentPort === null) {
  throw new Error("sqlite write queue worker requires a parent port");
}

type SqliteConnection = InstanceType<typeof BetterSqlite3>;

const connections = new Map<string, SqliteConnection>();
const extrasApplied = new Set<string>();
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

parentPort.postMessage({ type: "ready" } satisfies SqliteWriteQueueWorkerResponse);

parentPort.on("message", (message: unknown) => {
  const request = parseRequest(message);
  if (request === null) {
    const requestId = readRequestId(message);
    if (requestId !== null) {
      parentPort!.postMessage({
        type: "result",
        requestId,
        ok: false,
        error: "malformed sqlite write queue request"
      } satisfies SqliteWriteQueueWorkerResponse);
    }
    return;
  }
  if (request.type === "shutdown") {
    closeAllConnections();
    parentPort!.postMessage({
      type: "result",
      requestId: request.requestId,
      ok: true
    } satisfies SqliteWriteQueueWorkerResponse);
    return;
  }

  try {
    runStatements(request.filename, request.statements, request.sessionPragmas);
    parentPort!.postMessage({
      type: "result",
      requestId: request.requestId,
      ok: true
    } satisfies SqliteWriteQueueWorkerResponse);
  } catch (error) {
    parentPort!.postMessage({
      type: "result",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies SqliteWriteQueueWorkerResponse);
  }
});

function runStatements(
  filename: string,
  statements: readonly SqliteWriteStatement[],
  sessionPragmas: SqliteWriteQueueSessionPragmas | undefined
): void {
  if (filename === ":memory:") {
    throw new Error("sqlite write queue worker cannot open :memory: databases");
  }
  const connection = getOrOpenConnection(filename, sessionPragmas);
  const apply = connection.transaction(() => {
    for (const statement of statements) {
      connection.prepare(statement.sql).run(...(statement.params ?? []));
    }
  });
  apply.immediate();
}

function getOrOpenConnection(
  filename: string,
  sessionPragmas: SqliteWriteQueueSessionPragmas | undefined
): SqliteConnection {
  dropCachedWhenExtrasCleared(filename, sessionPragmas);
  const cached = connections.get(filename);
  if (cached !== undefined) {
    if (sessionPragmas !== undefined) {
      applySqliteWriteQueueSessionPragmas(cached, sessionPragmas);
      extrasApplied.add(filename);
    }
    return cached;
  }
  return openConnection(filename, sessionPragmas);
}

// Omitted extras after a handshake would keep bench cache_size on this live handle.
function dropCachedWhenExtrasCleared(
  filename: string,
  sessionPragmas: SqliteWriteQueueSessionPragmas | undefined
): void {
  if (sessionPragmas !== undefined || !extrasApplied.has(filename)) return;
  const cached = connections.get(filename);
  if (cached === undefined) {
    extrasApplied.delete(filename);
    return;
  }
  cached.close();
  connections.delete(filename);
  extrasApplied.delete(filename);
}

function openConnection(
  filename: string,
  sessionPragmas: SqliteWriteQueueSessionPragmas | undefined
): SqliteConnection {
  const connection = new BetterSqlite3(filename);
  applySqliteWritePragmas(connection, { busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS });
  if (sessionPragmas !== undefined) {
    applySqliteWriteQueueSessionPragmas(connection, sessionPragmas);
    extrasApplied.add(filename);
  }
  connections.set(filename, connection);
  return connection;
}

function closeAllConnections(): void {
  for (const connection of connections.values()) {
    connection.close();
  }
  connections.clear();
  extrasApplied.clear();
}

function parseRequest(message: unknown): SqliteWriteQueueWorkerRequest | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const record = message as {
    readonly type?: unknown;
    readonly requestId?: unknown;
    readonly filename?: unknown;
    readonly statements?: unknown;
    readonly jobId?: unknown;
    readonly kind?: unknown;
    readonly sessionPragmas?: unknown;
  };
  if (record.type === "shutdown" && typeof record.requestId === "number") {
    return { type: "shutdown", requestId: record.requestId };
  }
  if (
    record.type !== "run" ||
    typeof record.requestId !== "number" ||
    typeof record.jobId !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.filename !== "string" ||
    !Array.isArray(record.statements)
  ) {
    return null;
  }
  if (!isWriteJobKind(record.kind)) {
    return null;
  }
  const sessionPragmas = readOptionalSessionPragmas(record.sessionPragmas);
  if (sessionPragmas === "invalid") {
    return null;
  }
  return {
    type: "run",
    requestId: record.requestId,
    jobId: record.jobId,
    kind: record.kind,
    filename: record.filename,
    statements: record.statements as readonly SqliteWriteStatement[],
    ...(sessionPragmas === undefined ? {} : { sessionPragmas })
  };
}

function readOptionalSessionPragmas(
  value: unknown
): SqliteWriteQueueSessionPragmas | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  return isSqliteWriteQueueSessionPragmas(value) ? value : "invalid";
}

function isWriteJobKind(value: string): value is SqliteWriteJobKind {
  return (
    value === "event_log_transaction" || value === "ontology_write" || value === "maintenance"
  );
}

function readRequestId(message: unknown): number | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const requestId = (message as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "number" ? requestId : null;
}
