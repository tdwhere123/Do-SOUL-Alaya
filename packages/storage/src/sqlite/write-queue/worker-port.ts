import { bindQueueLifecycleObservation, createQueueLifecycleObservation, type QueueLifecycleObservation } from "./lifecycle-observation.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  createSerialSqliteWriteQueuePort,
  type SqliteWriteJob,
  type SqliteWriteQueuePort
} from "./port.js";
import {
  isSqliteWriteQueueWorkerResponse,
  type SqliteWriteQueueWorkerRequest
} from "./worker-protocol.js";
import { getSqliteWriteQueueSessionPragmas } from "./session-pragmas.js";

export interface WorkerThreadSqliteWriteQueueOptions {
  readonly workerUrl?: URL;
}

interface PendingWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface WorkerSession {
  readonly observation?: QueueLifecycleObservation;
  readonly worker: Worker;
  readonly pending: Map<number, PendingWaiter>;
  readonly ready: Promise<void>;
  closed: boolean;
  nextRequestId: number;
  failAllPending(error: Error): void;
}

export function resolveSqliteWriteQueueWorkerUrl(fromUrl: string = import.meta.url): URL | null {
  const sibling = new URL("./worker.js", fromUrl);
  if (existsSync(fileURLToPath(sibling))) {
    return sibling;
  }
  const builtFromSource = new URL("../../../dist/sqlite/write-queue/worker.js", fromUrl);
  return existsSync(fileURLToPath(builtFromSource)) ? builtFromSource : null;
}

function createReadyGate(): {
  readonly ready: Promise<void>;
  readonly markReady: () => void;
  readonly failReady: (error: Error) => void;
} {
  let markReady!: () => void;
  let failReady!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
    failReady = (error) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  return { ready, markReady, failReady };
}

function createWorkerSession(workerUrl: URL, observation: QueueLifecycleObservation | undefined): WorkerSession {
  const pending = new Map<number, PendingWaiter>();
  const { ready, markReady, failReady } = createReadyGate();
  const session: WorkerSession = {
    observation,
    worker: new Worker(workerUrl),
    pending,
    ready,
    closed: false,
    nextRequestId: 1,
    failAllPending(error) {
      for (const waiter of pending.values()) {
        waiter.reject(error);
      }
      pending.clear();
      if (observation) { observation.state.pendingRequests = 0; observation.publish(); }
    }
  };

  if (observation) {
    observation.state.threadId = session.worker.threadId;
    observation.state.readiness = "pending";
    observation.publish();
  }
  session.worker.on("message", (message: unknown) => {
    if (!isSqliteWriteQueueWorkerResponse(message)) return;
    if (message.type === "ready") {
      markReady();
      if (observation && observation.state.readiness === "pending") {
        observation.state.readiness = "ready"; observation.publish();
      }
      return;
    }
    const waiter = pending.get(message.requestId);
    if (waiter === undefined) return;
    pending.delete(message.requestId);
    if (observation) { observation.state.pendingRequests = pending.size; observation.publish(); }
    if (message.ok) {
      waiter.resolve();
      return;
    }
    waiter.reject(new Error(message.error));
  });

  session.worker.on("error", (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    failReady(normalized);
    if (observation && observation.state.readiness === "pending") {
      observation.state.readiness = "failed"; observation.publish();
    }
    session.failAllPending(normalized);
  });

  session.worker.on("exit", (code) => {
    if (observation) { observation.state.terminal = { code }; observation.publish(); }
    if (session.closed) return;
    const error = new Error(`sqlite write queue worker exited unexpectedly (code=${code})`);
    failReady(error);
    if (observation && observation.state.readiness === "pending") {
      observation.state.readiness = "failed"; observation.publish();
    }
    session.failAllPending(error);
  });

  return session;
}

async function postRequest(
  session: WorkerSession,
  request: SqliteWriteQueueWorkerRequest
): Promise<void> {
  await session.ready;
  if (session.closed) {
    throw new Error("sqlite write queue worker is closed");
  }
  await new Promise<void>((resolve, reject) => {
    session.pending.set(request.requestId, { resolve, reject });
    if (session.observation) {
      session.observation.state.pendingRequests = session.pending.size;
      session.observation.publish();
    }
    session.worker.postMessage(request);
  });
}

async function runPayloadJob(session: WorkerSession, job: SqliteWriteJob): Promise<void> {
  if (job.execute !== undefined) {
    // Closures cannot cross worker_threads; keep execute on the caller thread
    // inside the same serial chain so queued FIFO ordering still holds.
    await job.execute();
    return;
  }
  if (job.payload === undefined) {
    return;
  }
  if (job.filename === ":memory:") {
    throw new Error("worker-thread write queue cannot run payload jobs against :memory:");
  }
  const requestId = session.nextRequestId;
  session.nextRequestId += 1;
  const sessionPragmas = getSqliteWriteQueueSessionPragmas(job.filename);
  await postRequest(session, {
    type: "run",
    requestId,
    jobId: job.jobId,
    kind: job.kind,
    filename: job.filename,
    statements: job.payload.statements,
    ...(sessionPragmas === undefined ? {} : { sessionPragmas })
  });
}

async function closeWorker(session: WorkerSession): Promise<void> {
  if (session.closed) {
    return;
  }
  const observation = session.observation;
  const attempt = observation ? {
    id: observation.state.shutdowns.length + 1, closeId: observation.currentClose(),
    result: "pending" as "pending" | "acknowledged" | "failed",
    pendingBeforeTerminate: null as number | null, terminationRequested: false
  } : undefined;
  if (observation && attempt) { observation.state.shutdowns.push(attempt); observation.publish(); }
  // Send shutdown while the session still accepts protocol messages; serial
  // close drains the job chain before this runs.
  try {
    const requestId = session.nextRequestId;
    session.nextRequestId += 1;
    await postRequest(session, { type: "shutdown", requestId });
    if (attempt) attempt.result = "acknowledged";
  } catch {
    if (attempt) attempt.result = "failed";
    // Shutdown best-effort; always terminate the worker.
  }
  session.closed = true;
  if (observation && attempt) {
    attempt.pendingBeforeTerminate = session.pending.size;
    attempt.terminationRequested = true;
    observation.publish();
  }
  await (observation
    ? observation.terminate(() => session.worker.terminate())
    : session.worker.terminate());
  // Only waiters still pending after drain+shutdown (never handed a result).
  session.failAllPending(new Error("sqlite write queue worker closed"));
}

export function createWorkerThreadSqliteWriteQueuePort(
  options: WorkerThreadSqliteWriteQueueOptions = {}
): SqliteWriteQueuePort {
  const workerUrl = options.workerUrl ?? resolveSqliteWriteQueueWorkerUrl();
  if (workerUrl === null) {
    throw new Error("sqlite write queue worker script is missing; build @do-soul/alaya-storage first");
  }
  const observation = createQueueLifecycleObservation();
  const session = createWorkerSession(workerUrl, observation);
  const input = {
    kind: "worker-thread-sqlite-write-queue",
    runJob: (job: SqliteWriteJob) => runPayloadJob(session, job),
    close: () => closeWorker(session)
  };
  bindQueueLifecycleObservation(input, observation);
  return createSerialSqliteWriteQueuePort(input);
}
