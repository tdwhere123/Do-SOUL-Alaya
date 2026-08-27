import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isRecallEvalPagerIpcProgress,
  isRecallEvalPagerIpcResponse,
  type RecallEvalPagerIpcOp,
  type RecallEvalPagerIpcProgress,
  type RecallEvalPagerIpcRequest,
  type RecallEvalPagerIpcSuccess,
  type RecallEvalPagerMapsHint
} from "./protocol.js";
import { formatRecallEvalPagerMapsHint } from "./maps-hint.js";
import { RecallEvalSelectionArtifactCollector } from
  "./selection-artifact-collector.js";

export const DEFAULT_RECALL_EVAL_PAGER_TIMEOUT_MS = 600_000;

export interface RecallEvalPagerIpcProcess {
  readonly pid?: number;
  send(
    message: unknown,
    callback?: (error: Error | null) => void
  ): boolean;
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
  readonly op: RecallEvalPagerIpcOp;
  readonly resolve: (value: RecallEvalPagerIpcSuccess) => void;
  readonly reject: (error: unknown) => void;
  readonly clearAbort: () => void;
  readonly observeProgress: (progress: RecallEvalPagerIpcProgress) => void;
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
  private childEpoch = 0;
  private closing = false;
  private recycling = false;
  private openPayload: unknown | undefined;
  private readonly selectionArtifacts = new RecallEvalSelectionArtifactCollector();
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
    this.openPayload = payload;
    const response = await this.request("open", { open: payload }, timeoutMs);
    this.recordIdentity(response);
    return response;
  }

  public async recall(
    payload: unknown,
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<unknown> {
    await this.ensureOpened(timeoutMs);
    const response = await this.request("recall", { recall: payload }, timeoutMs);
    this.recordIdentity(response);
    if (response.pack === undefined || !hasRecallPack(response.pack)) {
      throw new Error("recall-eval pager child returned an empty pack.");
    }
    this.selectionArtifacts.recordQuestion(payload);
    return response.pack;
  }

  public async close(
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<unknown> {
    if (this.child === null) return this.selectionArtifacts.finalize();
    this.closing = true;
    await this.releaseAttachedChild(timeoutMs);
    return this.selectionArtifacts.finalize();
  }

  // invariant: pager child does not outlive a question (long-lived mmap SIGBUS).
  public async recycle(
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<void> {
    if (this.child === null) return;
    this.recycling = true;
    try {
      await this.releaseAttachedChild(timeoutMs);
    } finally {
      this.recycling = false;
    }
  }

  private async releaseAttachedChild(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (child === null) return;
    try {
      await this.closeAttachedChild(timeoutMs);
    } catch (error) {
      this.exitError ??= toPagerExitError(error, this.childPid, this.mapsHint);
      throw this.exitError;
    } finally {
      this.reapChild(child, this.exitError !== null);
    }
  }

  private async ensureOpened(timeoutMs: number): Promise<void> {
    if (this.exitError !== null) throw this.exitError;
    if (this.child !== null) return;
    if (this.openPayload === undefined) {
      throw new Error("recall-eval pager session is not open");
    }
    const response = await this.request("open", { open: this.openPayload }, timeoutMs);
    this.recordIdentity(response);
  }

  private async closeAttachedChild(timeoutMs: number): Promise<void> {
    try {
      const response = await this.request("close", {}, timeoutMs);
      this.selectionArtifacts.recordArtifact(response.selectionArtifact);
    } catch (error) {
      if (this.exitError !== null) throw this.exitError;
      if (
        error instanceof RecallEvalPagerChildExitedError &&
        isCleanPagerExit(error.code, error.exitSignal)
      ) {
        return;
      }
      throw error;
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
        this.pending, child, message, op, timeoutMs
      );
    } catch (error) {
      if (isPagerTimeoutError(error)) this.reapChild(child, true);
      throw error;
    }
  }

  private ensureChild(): RecallEvalPagerIpcProcess {
    if (this.exitError !== null) throw this.exitError;
    if (this.child !== null) return this.child;
    const host = this.host ?? createForkRecallEvalPagerHost();
    this.host = host;
    const child = this.spawnHost(host, this.childEpoch);
    const epoch = this.childEpoch;
    this.child = child;
    this.childPid = child.pid ?? this.childPid;
    child.on("message", (message) => this.onMessage(message));
    child.on("exit", (code, exitSignal) => this.onExit(epoch, code, exitSignal));
    child.on("error", (error) => this.onSpawnError(epoch, error));
    child.unref?.();
    return child;
  }

  private spawnHost(host: RecallEvalPagerIpcHost, epoch: number): RecallEvalPagerIpcProcess {
    try {
      const child = host.spawn();
      process.stdout.write(
        `[recall-eval pager] spawn pid=${child.pid ?? "unknown"}\n`
      );
      return child;
    } catch (error) {
      this.onSpawnError(epoch, error instanceof Error ? error : new Error(String(error)));
      throw this.exitError ?? error;
    }
  }

  private recordIdentity(response: RecallEvalPagerIpcSuccess): void {
    this.childPid = response.pid ?? this.child?.pid ?? this.childPid;
    this.mapsHint = response.mapsHint ?? this.mapsHint;
    this.selectionArtifacts.recordOpenRoot(response.selectionSpoolRootPath);
  }

  private onMessage(message: unknown): void {
    if (isRecallEvalPagerIpcProgress(message)) {
      this.pending.get(message.id)?.observeProgress(message);
      return;
    }
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

  private onExit(
    epoch: number,
    code: number | null,
    exitSignal: NodeJS.Signals | null
  ): void {
    if (epoch !== this.childEpoch) return;
    this.child = null;
    // Session close()/recycle() exit 0/SIGTERM must not fail-close the in-flight close.
    if ((this.closing || this.recycling) && isCleanPagerExit(code, exitSignal)) {
      resolvePendingAsSuccess(this.pending);
      return;
    }
    this.exitError = new RecallEvalPagerChildExitedError({
      code,
      exitSignal,
      childPid: this.childPid,
      mapsHint: this.mapsHint
    });
    rejectPendingIpc(this.pending, this.exitError);
  }

  private onSpawnError(epoch: number, error: Error): void {
    if (epoch !== this.childEpoch) return;
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

  private reapChild(child: RecallEvalPagerIpcProcess, failClosed: boolean): void {
    if (failClosed) {
      this.exitError ??= new RecallEvalPagerChildExitedError({
        code: 0,
        exitSignal: "SIGTERM",
        childPid: this.childPid,
        mapsHint: this.mapsHint
      });
    }
    this.childEpoch += 1;
    if (this.child === child) this.child = null;
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
  op: RecallEvalPagerIpcOp,
  timeoutMs: number
): Promise<RecallEvalPagerIpcSuccess> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastProgressSequence = 0;
    const armTimeout = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        failPending(
          pending,
          message.id,
          new Error(
            `recall-eval pager child timed out after ${timeoutMs}ms without progress.`
          )
        );
      }, timeoutMs);
    };
    armTimeout();
    pending.set(message.id, {
      op,
      resolve,
      reject,
      clearAbort: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
      observeProgress: (progress) => {
        if (progress.sequence <= lastProgressSequence) return;
        lastProgressSequence = progress.sequence;
        armTimeout();
      }
    });
    try {
      // False means the IPC write queue is full, not that the child is gone.
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

function resolvePendingAsSuccess(
  pending: Map<number, PendingIpcRequest>
): void {
  const waiting = [...pending.entries()];
  pending.clear();
  for (const [id, current] of waiting) {
    current.clearAbort();
    if (current.op === "close") {
      current.reject(new Error("recall-eval pager close response was lost before child exit."));
    } else {
      current.resolve({ id, ok: true });
    }
  }
}

function isCleanPagerExit(
  code: number | null,
  signal: NodeJS.Signals | null
): boolean {
  return code === 0 || signal === "SIGTERM";
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
