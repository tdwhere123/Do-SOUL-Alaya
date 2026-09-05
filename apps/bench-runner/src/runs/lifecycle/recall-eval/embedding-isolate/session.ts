import {
  P00_PERFORMANCE_PROOF_CONTRACT,
  notObserved,
  observedNumber,
  type ObservedFiniteNumber
} from "../performance-proof/attribution-receipt.js";
import {
  bindParentAbort,
  cancellationError,
  isAbortError,
  isCancellationError,
  isTimeoutError,
  timeoutError,
  waitForAbort
} from "./abort-signal.js";
import {
  EmbeddingIsolateIdentityError,
  freezeEmbeddingIsolateIdentity,
  proveLeaseIdentity,
  type EmbeddingIsolateIdentity,
  type FrozenEmbeddingIsolateIdentity
} from "./identity.js";
import { createStubEmbeddingIsolateHost } from "./stub-host.js";

export const P01_EMBEDDING_ISOLATE_CONTRACT = Object.freeze({
  name: "recall-eval-benchmark-embedding-isolate.v1",
  cites: P00_PERFORMANCE_PROOF_CONTRACT.name,
  module:
    "apps/bench-runner/src/runs/lifecycle/recall-eval/embedding-isolate/session.ts"
});

export type EmbeddingIsolateFailClosedReason =
  | "mismatch"
  | "uncertain"
  | "timeout"
  | "cancellation"
  | "daemon-start-failure"
  | "pager-recycle"
  | "child-exit"
  | "spawn-failure";

export class EmbeddingIsolateFailClosedError extends Error {
  public readonly reason: EmbeddingIsolateFailClosedReason;

  public constructor(reason: EmbeddingIsolateFailClosedReason, message?: string) {
    super(message ?? `embedding isolate fail-closed (${reason})`);
    this.name = "EmbeddingIsolateFailClosedError";
    this.reason = reason;
  }
}

export interface EmbeddingIsolateChild {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface EmbeddingIsolateHost {
  spawn(identity: FrozenEmbeddingIsolateIdentity): EmbeddingIsolateChild;
  warmup?(
    child: EmbeddingIsolateChild,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<void>;
  embed?(
    child: EmbeddingIsolateChild,
    texts: readonly string[],
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<readonly Float32Array[]>;
}

export interface EmbeddingIsolateLease {
  readonly id: string;
  readonly identity: FrozenEmbeddingIsolateIdentity;
  readonly workspaceId: string;
}

export interface EmbeddingIsolateRetainedState {
  readonly modelReady: boolean;
  readonly identity: FrozenEmbeddingIsolateIdentity | null;
  readonly activeLease: EmbeddingIsolateLease | null;
  readonly queryEmbeddingResults: readonly never[];
  readonly documentObservations: readonly never[];
  readonly recallCandidates: readonly never[];
  readonly workspaceHandles: readonly never[];
  readonly selectionState: readonly never[];
  readonly deliveryResults: readonly never[];
}

export interface EmbeddingIsolateAttribution {
  readonly contract: typeof P00_PERFORMANCE_PROOF_CONTRACT.name;
  readonly modelChildSpawnCount: ObservedFiniteNumber;
  readonly modelReadinessCount: ObservedFiniteNumber;
  readonly modelReadinessMs: ObservedFiniteNumber;
  readonly clockAMs: ObservedFiniteNumber;
  readonly liveChildCount: ObservedFiniteNumber;
  readonly activeLeaseCount: ObservedFiniteNumber;
  readonly liveChildPids: readonly number[];
}

export interface EmbeddingIsolateSessionInput {
  readonly identity: EmbeddingIsolateIdentity;
  readonly host?: EmbeddingIsolateHost;
  readonly timeoutMs?: number;
  readonly clockAMs?: ObservedFiniteNumber;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const CLOCK_A_REASON = "embedding isolate does not execute daemon.recall";
const READINESS_REASON = "embedding isolate was not opened";
const CHILD_PID_REASON = "embedding isolate child pid was not sampled";
const OP_LABEL = "embedding isolate";

export class EmbeddingIsolateSession {
  private readonly identity: FrozenEmbeddingIsolateIdentity;
  private readonly host: EmbeddingIsolateHost;
  private readonly defaultTimeoutMs: number;
  private readonly clockAMs: ObservedFiniteNumber;
  private child: EmbeddingIsolateChild | null = null;
  private childEpoch = 0;
  private activeLease: EmbeddingIsolateLease | null = null;
  private nextLeaseId = 0;
  private busy = false;
  private modelReady = false;
  private closed = false;
  private failClosedReason: EmbeddingIsolateFailClosedReason | null = null;
  private spawnCount = 0;
  private readinessCount = 0;
  private readinessMs: number | null = null;
  private reaping = false;
  private opAbort = new AbortController();

  public constructor(input: EmbeddingIsolateSessionInput) {
    this.identity = freezeEmbeddingIsolateIdentity(input.identity);
    this.host = input.host ?? createStubEmbeddingIsolateHost();
    this.defaultTimeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clockAMs = input.clockAMs ?? notObserved(CLOCK_A_REASON);
  }

  public get ownerIdentity(): FrozenEmbeddingIsolateIdentity {
    return this.identity;
  }

  public get isDead(): boolean {
    return this.closed || this.failClosedReason !== null;
  }

  public get deadReason(): EmbeddingIsolateFailClosedReason | null {
    return this.failClosedReason;
  }

  public async open(
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
  ): Promise<void> {
    this.assertRunnable();
    if (this.child !== null && this.modelReady) return;
    await this.withExclusive("open", () => this.spawnAndWarm(options));
  }

  public lease(
    claimed: EmbeddingIsolateIdentity,
    workspaceId: string
  ): EmbeddingIsolateLease {
    this.assertRunnable();
    if (this.busy) this.failClosed("uncertain", "embedding isolate is busy");
    if (this.child === null || !this.modelReady) {
      this.failClosed("uncertain", "embedding isolate is not ready");
    }
    if (this.activeLease !== null) {
      this.failClosed("uncertain", "embedding isolate already has an active lease");
    }
    const proven = this.proveOrFail(claimed);
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      this.failClosed("uncertain", "embedding isolate workspaceId is empty or not a string");
    }
    const issued: EmbeddingIsolateLease = Object.freeze({
      id: `lease-${++this.nextLeaseId}`,
      identity: proven,
      workspaceId
    });
    this.activeLease = issued;
    return issued;
  }

  public release(issued: EmbeddingIsolateLease): void {
    this.assertRunnable();
    if (this.activeLease === null || this.activeLease.id !== issued.id) {
      this.failClosed("uncertain", "embedding isolate lease is not active");
    }
    this.activeLease = null;
  }

  public async embed(
    issued: EmbeddingIsolateLease,
    texts: readonly string[],
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
  ): Promise<readonly Float32Array[]> {
    this.assertRunnable();
    if (this.activeLease === null || this.activeLease.id !== issued.id) {
      this.failClosed("uncertain", "embed requires the active isolate lease");
    }
    return this.withExclusive("embed", () => this.embedOnce(texts, options));
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.activeLease = null;
    this.reapOwner();
  }

  // Recycle is pager fail-closed, not keep-alive. Intern amortization across
  // session.recycle() was falsified under an isolated pager.
  public async recycle(): Promise<void> {
    this.terminate("pager-recycle");
  }

  public failClosed(
    reason: EmbeddingIsolateFailClosedReason,
    message?: string
  ): never {
    throw this.terminate(reason, message);
  }

  public inspectRetained(): EmbeddingIsolateRetainedState {
    return Object.freeze({
      modelReady: this.modelReady,
      identity: this.identity,
      activeLease: this.activeLease,
      queryEmbeddingResults: Object.freeze([]) as readonly never[],
      documentObservations: Object.freeze([]) as readonly never[],
      recallCandidates: Object.freeze([]) as readonly never[],
      workspaceHandles: Object.freeze([]) as readonly never[],
      selectionState: Object.freeze([]) as readonly never[],
      deliveryResults: Object.freeze([]) as readonly never[]
    });
  }

  public inspectAttribution(): EmbeddingIsolateAttribution {
    return Object.freeze({
      contract: P00_PERFORMANCE_PROOF_CONTRACT.name,
      modelChildSpawnCount: observedNumber(this.spawnCount),
      modelReadinessCount: observedNumber(this.readinessCount),
      modelReadinessMs: this.readinessMs === null
        ? notObserved(READINESS_REASON)
        : observedNumber(this.readinessMs),
      clockAMs: this.clockAMs,
      liveChildCount: this.observeLiveChildCount(),
      activeLeaseCount: observedNumber(this.activeLease === null ? 0 : 1),
      liveChildPids: Object.freeze(this.knownLivePids())
    });
  }

  private async spawnAndWarm(options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = performance.now();
    const child = this.spawnOwner();
    try {
      await this.runChildOp(
        timeoutMs,
        options.signal,
        (signal) => this.host.warmup?.(child, signal, timeoutMs) ?? Promise.resolve()
      );
    } catch (error) {
      this.rethrowAsFailClosed(error);
    }
    this.modelReady = true;
    this.readinessCount += 1;
    this.readinessMs = performance.now() - startedAt;
  }

  private async embedOnce(
    texts: readonly string[],
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal }
  ): Promise<readonly Float32Array[]> {
    const child = this.child;
    if (child === null) this.failClosed("uncertain", "embedding isolate child is missing");
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    try {
      return await this.runChildOp(
        timeoutMs,
        options.signal,
        (signal) => this.host.embed?.(child, texts, signal, timeoutMs) ??
          Promise.resolve(stubVectors(texts.length))
      );
    } catch (error) {
      this.rethrowAsFailClosed(error);
    }
  }

  private spawnOwner(): EmbeddingIsolateChild {
    const epoch = ++this.childEpoch;
    try {
      const child = this.host.spawn(this.identity);
      this.child = child;
      this.spawnCount += 1;
      child.on("exit", (code, signal) => this.onChildExit(epoch, code, signal));
      child.on("error", () => this.onChildError(epoch));
      return child;
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      const closed = this.terminate("spawn-failure", wrapped.message);
      closed.cause = wrapped;
      throw closed;
    }
  }

  private async runChildOp<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const abort = new AbortController();
    const stopParent = bindParentAbort(signal, abort);
    const stopOwner = bindParentAbort(this.opAbort.signal, abort);
    const timer = setTimeout(
      () => abort.abort(timeoutError(timeoutMs, OP_LABEL)),
      timeoutMs
    );
    try {
      if (signal?.aborted) throw cancellationError(OP_LABEL);
      return await Promise.race([run(abort.signal), waitForAbort(abort.signal)]);
    } finally {
      clearTimeout(timer);
      stopParent();
      stopOwner();
    }
  }

  private async withExclusive<T>(_op: string, run: () => Promise<T>): Promise<T> {
    if (this.busy) this.failClosed("uncertain", "embedding isolate is busy");
    this.busy = true;
    try {
      return await run();
    } finally {
      this.busy = false;
    }
  }

  private proveOrFail(
    claimed: EmbeddingIsolateIdentity
  ): FrozenEmbeddingIsolateIdentity {
    try {
      return proveLeaseIdentity(claimed, this.identity);
    } catch (error) {
      if (error instanceof EmbeddingIsolateIdentityError) {
        this.failClosed(error.kind, error.message);
      }
      throw error;
    }
  }

  private assertRunnable(): void {
    if (this.failClosedReason !== null) {
      throw new EmbeddingIsolateFailClosedError(this.failClosedReason);
    }
    if (this.closed) {
      throw new Error("embedding isolate is closed");
    }
  }

  private onChildExit(
    epoch: number,
    _code: number | null,
    _signal: NodeJS.Signals | null
  ): void {
    if (epoch !== this.childEpoch || this.reaping || this.closed) return;
    this.child = null;
    this.modelReady = false;
    if (this.failClosedReason !== null) return;
    this.failClosedReason = "child-exit";
    this.activeLease = null;
    if (!this.opAbort.signal.aborted) this.opAbort.abort(cancellationError(OP_LABEL));
  }

  private onChildError(epoch: number): void {
    if (epoch !== this.childEpoch || this.reaping || this.closed) return;
    if (this.failClosedReason !== null) {
      this.reapOwner();
      return;
    }
    this.terminate("child-exit");
  }

  private terminate(
    reason: EmbeddingIsolateFailClosedReason,
    message?: string
  ): EmbeddingIsolateFailClosedError {
    this.failClosedReason = reason;
    this.activeLease = null;
    this.modelReady = false;
    if (!this.opAbort.signal.aborted) this.opAbort.abort(cancellationError(OP_LABEL));
    this.reapOwner();
    return new EmbeddingIsolateFailClosedError(reason, message);
  }

  private reapOwner(): void {
    const child = this.child;
    if (child === null) return;
    this.reaping = true;
    this.childEpoch += 1;
    this.child = null;
    this.modelReady = false;
    try {
      child.kill("SIGTERM");
    } catch {
      // Child may already be gone.
    } finally {
      this.reaping = false;
    }
  }

  private rethrowAsFailClosed(error: unknown): never {
    if (error instanceof EmbeddingIsolateFailClosedError) throw error;
    if (this.failClosedReason !== null) {
      throw new EmbeddingIsolateFailClosedError(this.failClosedReason);
    }
    if (isTimeoutError(error)) this.failClosed("timeout", error.message);
    if (isCancellationError(error, OP_LABEL) || isAbortError(error)) {
      this.failClosed("cancellation");
    }
    this.failClosed("uncertain", error instanceof Error ? error.message : String(error));
  }

  private observeLiveChildCount(): ObservedFiniteNumber {
    if (this.child === null) return observedNumber(0);
    if (typeof this.child.pid !== "number") return notObserved(CHILD_PID_REASON);
    return observedNumber(1);
  }

  private knownLivePids(): number[] {
    const pid = this.child?.pid;
    return typeof pid === "number" ? [pid] : [];
  }
}

export function createEmbeddingIsolateSession(
  input: EmbeddingIsolateSessionInput
): EmbeddingIsolateSession {
  return new EmbeddingIsolateSession(input);
}

function stubVectors(count: number): readonly Float32Array[] {
  return Array.from({ length: count }, () => new Float32Array(4));
}
