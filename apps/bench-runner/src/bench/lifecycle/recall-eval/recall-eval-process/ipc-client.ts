import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isRecallEvalPagerIpcResponse,
  type RecallEvalPagerIpcOp,
  type RecallEvalPagerIpcRequest,
  type RecallEvalPagerIpcSuccess,
  type RecallEvalPagerMapsHint
} from "./protocol.js";
import { formatRecallEvalPagerMapsHint } from "./maps-hint.js";

export const DEFAULT_RECALL_EVAL_PAGER_TIMEOUT_MS = 600_000;

export interface RecallEvalPagerIpcProcess {
  readonly pid?: number;
  send(message: unknown): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): void;
  readonly channel?: { unref(): void } | null;
}

export interface RecallEvalPagerIpcHost {
  spawn(): RecallEvalPagerIpcProcess;
}

interface PendingIpcRequest {
  readonly resolve: (value: RecallEvalPagerIpcSuccess) => void;
  readonly reject: (error: unknown) => void;
  readonly clearAbort: () => void;
}

export class RecallEvalPagerChildExitedError extends Error {
  public readonly code: number | null;
  public readonly exitSignal: NodeJS.Signals | null;
  public readonly childPid: number | null;
  public readonly mapsHint: RecallEvalPagerMapsHint | null;

  public constructor(input: {
    readonly code: number | null;
    readonly exitSignal: NodeJS.Signals | null;
    readonly childPid?: number | null;
    readonly mapsHint?: RecallEvalPagerMapsHint | null;
  }) {
    super(formatPagerExit(input));
    this.name = "RecallEvalPagerChildExitedError";
    this.code = input.code;
    this.exitSignal = input.exitSignal;
    this.childPid = input.childPid ?? null;
    this.mapsHint = input.mapsHint ?? null;
  }
}

export function resolveRecallEvalPagerChildScript(
  fromUrl: string = import.meta.url
): string {
  const candidates = [
    new URL("./child.js", fromUrl),
    new URL(
      "../../../../dist/bench/lifecycle/recall-eval/recall-eval-process/child.js",
      fromUrl
    )
  ];
  for (const candidate of candidates) {
    const scriptPath = fileURLToPath(candidate);
    if (existsSync(scriptPath)) return scriptPath;
  }
  throw new Error(
    "recall-eval pager child script is missing; build @do-soul/alaya-bench-runner."
  );
}

export function createForkRecallEvalPagerHost(
  scriptPath: string = resolveRecallEvalPagerChildScript()
): RecallEvalPagerIpcHost {
  return { spawn: () => spawnRecallEvalPagerChild(scriptPath) };
}

export class RecallEvalPagerIpcSession {
  private host: RecallEvalPagerIpcHost | undefined;
  private child: RecallEvalPagerIpcProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingIpcRequest>();
  private exitError: RecallEvalPagerChildExitedError | null = null;
  private mapsHint: RecallEvalPagerMapsHint | null = null;
  private childPid: number | null = null;
  private readonly defaultTimeoutMs: number;

  public constructor(input: {
    readonly host?: RecallEvalPagerIpcHost;
    readonly timeoutMs?: number;
  } = {}) {
    this.host = input.host;
    this.defaultTimeoutMs = input.timeoutMs ?? DEFAULT_RECALL_EVAL_PAGER_TIMEOUT_MS;
  }

  public get pid(): number | null {
    return this.childPid ?? this.child?.pid ?? null;
  }

  public get lastMapsHint(): RecallEvalPagerMapsHint | null {
    return this.mapsHint;
  }

  public async open(
    payload: unknown,
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<RecallEvalPagerIpcSuccess> {
    const response = await this.request("open", { open: payload }, timeoutMs);
    this.childPid = response.pid ?? this.child?.pid ?? this.childPid;
    this.mapsHint = response.mapsHint ?? this.mapsHint;
    return response;
  }

  public async recall(
    payload: unknown,
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<unknown> {
    const response = await this.request("recall", { recall: payload }, timeoutMs);
    this.childPid = response.pid ?? this.child?.pid ?? this.childPid;
    this.mapsHint = response.mapsHint ?? this.mapsHint;
    if (response.pack === undefined || !hasRecallPack(response.pack)) {
      throw new Error("recall-eval pager child returned an empty pack.");
    }
    return response.pack;
  }

  public async close(
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<unknown> {
    const child = this.child;
    if (child === null) return null;
    try {
      const response = await this.request("close", {}, timeoutMs);
      return response.selectionArtifact ?? null;
    } catch (error) {
      this.exitError ??= toPagerExitError(error, this.childPid, this.mapsHint);
      throw this.exitError;
    } finally {
      this.killChild(child);
    }
  }

  private async request(
    op: RecallEvalPagerIpcOp,
    extra: Pick<RecallEvalPagerIpcRequest, "open" | "recall">,
    timeoutMs: number
  ): Promise<RecallEvalPagerIpcSuccess> {
    const child = this.ensureChild();
    const id = ++this.nextId;
    const message: RecallEvalPagerIpcRequest = {
      id,
      op,
      timeoutMs,
      ...extra
    };
    try {
      return await waitForPagerIpcResponse(
        this.pending, child, message, timeoutMs
      );
    } catch (error) {
      if (isPagerTimeoutError(error)) this.killChild(child);
      throw error;
    }
  }

  private ensureChild(): RecallEvalPagerIpcProcess {
    if (this.exitError !== null) throw this.exitError;
    if (this.child !== null) return this.child;
    const host = this.host ?? createForkRecallEvalPagerHost();
    this.host = host;
    const child = host.spawn();
    this.child = child;
    this.childPid = child.pid ?? this.childPid;
    child.on("message", (message) => this.onMessage(message));
    child.on("exit", (code, exitSignal) => this.onExit(code, exitSignal));
    child.on("error", (error) => this.onSpawnError(error));
    child.unref?.();
    return child;
  }

  private onMessage(message: unknown): void {
    if (!isRecallEvalPagerIpcResponse(message)) return;
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

  private onExit(code: number | null, exitSignal: NodeJS.Signals | null): void {
    this.child = null;
    this.exitError = new RecallEvalPagerChildExitedError({
      code,
      exitSignal,
      childPid: this.childPid,
      mapsHint: this.mapsHint
    });
    rejectPendingIpc(this.pending, this.exitError);
  }

  private onSpawnError(error: Error): void {
    this.child = null;
    this.exitError = new RecallEvalPagerChildExitedError({
      code: null,
      exitSignal: null,
      childPid: this.childPid,
      mapsHint: this.mapsHint
    });
    this.exitError.cause = error;
    rejectPendingIpc(this.pending, this.exitError);
  }

  private killChild(child: RecallEvalPagerIpcProcess): void {
    this.exitError ??= new RecallEvalPagerChildExitedError({
      code: 0,
      exitSignal: "SIGTERM",
      childPid: this.childPid,
      mapsHint: this.mapsHint
    });
    this.child = null;
    try {
      child.kill("SIGTERM");
    } catch {
      // Child may already be gone.
    }
  }
}

export function createRecallEvalPagerSession(input: {
  readonly host?: RecallEvalPagerIpcHost;
  readonly timeoutMs?: number;
} = {}): RecallEvalPagerIpcSession {
  return new RecallEvalPagerIpcSession(input);
}

function spawnRecallEvalPagerChild(scriptPath: string): ChildProcess {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = fork(scriptPath, [], {
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    serialization: "advanced",
    env
  });
  child.unref();
  child.channel?.unref();
  return child;
}

function waitForPagerIpcResponse(
  pending: Map<number, PendingIpcRequest>,
  child: RecallEvalPagerIpcProcess,
  message: RecallEvalPagerIpcRequest,
  timeoutMs: number
): Promise<RecallEvalPagerIpcSuccess> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      failPending(
        pending,
        message.id,
        new Error(`recall-eval pager child timed out after ${timeoutMs}ms.`)
      );
    }, timeoutMs);
    pending.set(message.id, {
      resolve,
      reject,
      clearAbort: () => clearTimeout(timer)
    });
    try {
      if (!child.send(message)) {
        failPending(
          pending,
          message.id,
          new Error("recall-eval pager child IPC send failed.")
        );
      }
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

function isPagerTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out after \d+ms/u.test(error.message);
}

function hasRecallPack(pack: unknown): boolean {
  if (typeof pack !== "object" || pack === null) return false;
  const record = pack as { readonly questionId?: unknown; readonly diagnostics?: unknown };
  return typeof record.questionId === "string" &&
    record.questionId.length > 0 &&
    record.diagnostics !== undefined &&
    record.diagnostics !== null;
}

function formatPagerExit(input: {
  readonly code: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly childPid?: number | null;
  readonly mapsHint?: RecallEvalPagerMapsHint | null;
}): string {
  const pid = input.childPid ?? input.mapsHint?.pid ?? "unknown";
  const maps = input.mapsHint === undefined || input.mapsHint === null
    ? "maps=unsampled"
    : formatRecallEvalPagerMapsHint(input.mapsHint);
  return (
    `recall-eval pager child exited (pid=${pid}, code=${input.code}, ` +
    `signal=${input.exitSignal}, ${maps}).`
  );
}

function toPagerExitError(
  error: unknown,
  childPid: number | null,
  mapsHint: RecallEvalPagerMapsHint | null
): RecallEvalPagerChildExitedError {
  if (error instanceof RecallEvalPagerChildExitedError) return error;
  const wrapped = new RecallEvalPagerChildExitedError({
    code: null,
    exitSignal: null,
    childPid,
    mapsHint
  });
  wrapped.cause = error;
  return wrapped;
}
