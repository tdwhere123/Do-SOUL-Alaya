import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isLocalOnnxEmbeddingIpcResponse,
  type LocalOnnxEmbeddingIpcOp,
  type LocalOnnxEmbeddingIpcRequest,
  type LocalOnnxEmbeddingIpcSuccess
} from "./protocol.js";
import { decodeLocalOnnxIpcVectors } from "./vectors.js";

export interface LocalOnnxEmbeddingIpcProcess {
  readonly pid?: number;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): void;
}

export interface LocalOnnxEmbeddingIpcHost {
  spawn(): LocalOnnxEmbeddingIpcProcess;
}

interface LocalOnnxEmbeddingIpcSessionInput {
  readonly modelId: string;
  readonly cacheDir: string | null;
  readonly schemaVersion: number;
  readonly host?: LocalOnnxEmbeddingIpcHost;
}

interface PendingIpcRequest {
  readonly resolve: (value: LocalOnnxEmbeddingIpcSuccess) => void;
  readonly reject: (error: unknown) => void;
  readonly clearAbort: () => void;
}

export class LocalOnnxEmbeddingChildExitedError extends Error {
  public readonly code: number | null;
  public readonly exitSignal: NodeJS.Signals | null;

  public constructor(code: number | null, exitSignal: NodeJS.Signals | null) {
    super(
      `Local ONNX embedding child process exited (code=${code}, signal=${exitSignal}).`
    );
    this.name = "LocalOnnxEmbeddingChildExitedError";
    this.code = code;
    this.exitSignal = exitSignal;
  }
}

export function isLocalOnnxEmbeddingChildExitedError(
  error: unknown
): error is LocalOnnxEmbeddingChildExitedError {
  return error instanceof LocalOnnxEmbeddingChildExitedError;
}

export function resolveLocalOnnxEmbeddingChildScript(
  fromUrl: string = import.meta.url
): string {
  const candidates = [
    new URL("./child.js", fromUrl),
    new URL("../../../dist/embedding-recall/local-onnx-process/child.js", fromUrl)
  ];
  for (const candidate of candidates) {
    const scriptPath = fileURLToPath(candidate);
    if (existsSync(scriptPath)) return scriptPath;
  }
  throw new Error(
    "local ONNX embedding child script is missing; build @do-soul/alaya-core."
  );
}

export function createForkLocalOnnxEmbeddingHost(
  scriptPath: string = resolveLocalOnnxEmbeddingChildScript()
): LocalOnnxEmbeddingIpcHost {
  return {
    spawn: () => spawnLocalOnnxEmbeddingChild(scriptPath)
  };
}

export class LocalOnnxEmbeddingIpcSession {
  private readonly modelId: string;
  private readonly cacheDir: string | null;
  private readonly schemaVersion: number;
  private host: LocalOnnxEmbeddingIpcHost | undefined;
  private child: LocalOnnxEmbeddingIpcProcess | null = null;
  private nextId = 0;
  private childEpoch = 0;
  private readonly pending = new Map<number, PendingIpcRequest>();
  private exitError: LocalOnnxEmbeddingChildExitedError | null = null;

  public constructor(input: LocalOnnxEmbeddingIpcSessionInput) {
    this.modelId = input.modelId;
    this.cacheDir = input.cacheDir;
    this.schemaVersion = input.schemaVersion;
    this.host = input.host;
  }

  public warmup(signal: AbortSignal): Promise<void> {
    return this.request("warmup", undefined, signal).then(() => undefined);
  }

  public async embedTexts(
    texts: readonly string[],
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<readonly Float32Array[]> {
    const response = await this.request("embed", texts, signal, timeoutMs);
    return decodeLocalOnnxIpcVectors(response.vectors, texts.length);
  }

  public async close(): Promise<void> {
    const child = this.child;
    this.childEpoch += 1;
    this.exitError ??= new LocalOnnxEmbeddingChildExitedError(0, "SIGTERM");
    this.child = null;
    rejectPendingIpc(this.pending, this.exitError);
    if (child === null) return;
    try {
      child.send(this.buildRequest(++this.nextId, "close"));
    } catch {
      // Child may already be gone; kill still reaps the handle.
    }
    child.kill("SIGTERM");
  }

  private async request(
    op: LocalOnnxEmbeddingIpcOp,
    texts: readonly string[] | undefined,
    signal: AbortSignal,
    timeoutMs?: number
  ): Promise<LocalOnnxEmbeddingIpcSuccess> {
    const child = this.ensureChild();
    const id = ++this.nextId;
    const message = this.buildRequest(id, op, texts, timeoutMs);
    return await waitForLocalOnnxIpcResponse(
      this.pending,
      child,
      message,
      signal,
      (error) => this.recycleAfterAbort(child, message.id, error)
    );
  }

  private ensureChild(): LocalOnnxEmbeddingIpcProcess {
    if (this.exitError !== null) throw this.exitError;
    if (this.child !== null) return this.child;
    const host = this.host ?? createForkLocalOnnxEmbeddingHost();
    this.host = host;
    const child = host.spawn();
    this.child = child;
    const epoch = this.childEpoch;
    child.on("message", (message) => this.onMessage(message));
    child.on("exit", (code, exitSignal) => this.onExit(epoch, code, exitSignal));
    child.on("error", (error) => this.onSpawnError(epoch, error));
    // IPC must not pin the pager/daemon event loop after recall finishes.
    child.unref?.();
    return child;
  }

  private onMessage(message: unknown): void {
    if (!isLocalOnnxEmbeddingIpcResponse(message)) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    pending.clearAbort();
    if (message.ok === false) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message);
  }

  private onExit(
    epoch: number,
    code: number | null,
    exitSignal: NodeJS.Signals | null
  ): void {
    if (epoch !== this.childEpoch) return;
    this.child = null;
    this.exitError = new LocalOnnxEmbeddingChildExitedError(code, exitSignal);
    rejectPendingIpc(this.pending, this.exitError);
  }

  private onSpawnError(epoch: number, error: Error): void {
    if (epoch !== this.childEpoch) return;
    this.child = null;
    this.exitError = new LocalOnnxEmbeddingChildExitedError(null, null);
    this.exitError.cause = error;
    rejectPendingIpc(this.pending, this.exitError);
  }

  private recycleAfterAbort(
    child: LocalOnnxEmbeddingIpcProcess,
    id: number,
    error: unknown
  ): void {
    failPending(this.pending, id, error);
    if (this.child !== child) return;
    this.childEpoch += 1;
    this.child = null;
    rejectPendingIpc(
      this.pending,
      new LocalOnnxEmbeddingChildExitedError(null, "SIGTERM")
    );
    try {
      child.kill("SIGTERM");
    } catch {
      // Child may already be gone; the epoch invalidates late events.
    }
  }

  private buildRequest(
    id: number,
    op: LocalOnnxEmbeddingIpcOp,
    texts?: readonly string[],
    timeoutMs?: number
  ): LocalOnnxEmbeddingIpcRequest {
    return {
      id,
      op,
      modelId: this.modelId,
      cacheDir: this.cacheDir,
      schemaVersion: this.schemaVersion,
      ...(texts === undefined ? {} : { texts }),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    };
  }
}

function spawnLocalOnnxEmbeddingChild(scriptPath: string): ChildProcess {
  const env = { ...process.env };
  // Inherited inspect/loader flags would pull the pager's tooling into ORT.
  delete env.NODE_OPTIONS;
  const child = fork(scriptPath, [], {
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env
  });
  // Process-handle unref is not enough: the IPC pipe still refs the event loop.
  child.unref();
  child.channel?.unref();
  return child;
}

function waitForLocalOnnxIpcResponse(
  pending: Map<number, PendingIpcRequest>,
  child: LocalOnnxEmbeddingIpcProcess,
  message: LocalOnnxEmbeddingIpcRequest,
  signal: AbortSignal,
  onAbortRequest: (error: unknown) => void
): Promise<LocalOnnxEmbeddingIpcSuccess> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      onAbortRequest(ipcAbortError(signal));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    pending.set(message.id, {
      resolve,
      reject,
      clearAbort: () => signal.removeEventListener("abort", onAbort)
    });
    try {
      child.send(message, (error) => {
        if (error != null) failPending(pending, message.id, error);
      });
    } catch (error) {
      failPending(pending, message.id, error);
    }
  });
}

function failPending(
  pending: Map<number, PendingIpcRequest>,
  id: number,
  error: unknown
): void {
  const current = pending.get(id);
  if (current === undefined) return;
  pending.delete(id);
  current.clearAbort();
  current.reject(error);
}

function rejectPendingIpc(
  pending: Map<number, PendingIpcRequest>,
  error: unknown
): void {
  const waiting = [...pending.values()];
  pending.clear();
  for (const current of waiting) {
    current.clearAbort();
    current.reject(error);
  }
}

function ipcAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Local ONNX embedding was cancelled.");
}
