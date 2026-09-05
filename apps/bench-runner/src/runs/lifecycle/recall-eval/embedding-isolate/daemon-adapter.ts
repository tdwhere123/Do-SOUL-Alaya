import {
  bindParentAbort,
  cancellationError,
  isAbortError,
  isTimeoutError,
  timeoutError,
  waitForAbort
} from "./abort-signal.js";
import {
  EmbeddingIsolateIdentityError,
  proveLeaseIdentity,
  type EmbeddingIsolateIdentity
} from "./identity.js";
import {
  EmbeddingIsolateFailClosedError,
  type EmbeddingIsolateFailClosedReason,
  type EmbeddingIsolateLease,
  type EmbeddingIsolateSession
} from "./session.js";

export interface EmbeddingIsolateDaemonHandle {
  readonly pid?: number;
  shutdown(): Promise<void>;
}

export interface EmbeddingIsolateLeasedDaemon {
  readonly lease: EmbeddingIsolateLease;
  readonly handle: EmbeddingIsolateDaemonHandle;
  shutdown(): Promise<void>;
}

export interface EmbeddingIsolateDaemonStart {
  readonly workspaceId: string;
  readonly claimedIdentity: EmbeddingIsolateIdentity;
  readonly start: (signal: AbortSignal) => Promise<EmbeddingIsolateDaemonHandle>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class EmbeddingIsolateDaemonAdapter {
  private readonly session: EmbeddingIsolateSession;
  private readonly defaultTimeoutMs: number;
  private readonly daemons = new Set<EmbeddingIsolateDaemonHandle>();

  public constructor(input: {
    readonly session: EmbeddingIsolateSession;
    readonly timeoutMs?: number;
  }) {
    this.session = input.session;
    this.defaultTimeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async startWorkspace(
    input: EmbeddingIsolateDaemonStart,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
  ): Promise<EmbeddingIsolateLeasedDaemon> {
    this.proveBeforeStart(input.claimedIdentity);
    if (this.session.inspectRetained().activeLease !== null) {
      await this.reapDaemons();
      this.session.failClosed(
        "uncertain",
        "embedding isolate already has an active lease"
      );
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const handle = await this.startDaemon(input, timeoutMs, options.signal);
    try {
      const lease = this.session.lease(input.claimedIdentity, input.workspaceId);
      return {
        lease,
        handle,
        shutdown: () => this.shutdownWorkspace(lease, handle)
      };
    } catch (error) {
      await this.reapDaemons();
      throw error;
    }
  }

  public async shutdownWorkspace(
    lease: EmbeddingIsolateLease,
    handle: EmbeddingIsolateDaemonHandle
  ): Promise<void> {
    await this.shutdownHandle(handle);
    if (!this.session.isDead) this.session.release(lease);
  }

  public async recyclePager(): Promise<void> {
    await this.reapDaemons();
    if (!this.session.isDead) await this.session.recycle();
  }

  public async close(): Promise<void> {
    await this.reapDaemons();
    await this.session.close();
  }

  public liveDaemonPids(): readonly number[] {
    return Object.freeze(
      [...this.daemons]
        .map((handle) => handle.pid)
        .filter((pid): pid is number => typeof pid === "number")
    );
  }

  private proveBeforeStart(claimed: EmbeddingIsolateIdentity): void {
    try {
      proveLeaseIdentity(claimed, this.session.ownerIdentity);
    } catch (error) {
      const reason = error instanceof EmbeddingIsolateIdentityError
        ? error.kind
        : "uncertain";
      this.session.failClosed(reason, error instanceof Error ? error.message : String(error));
    }
  }

  private async startDaemon(
    input: EmbeddingIsolateDaemonStart,
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<EmbeddingIsolateDaemonHandle> {
    const abort = new AbortController();
    const stopParent = bindParentAbort(signal, abort);
    const timer = setTimeout(
      () => abort.abort(timeoutError(timeoutMs, "embedding isolate daemon start")),
      timeoutMs
    );
    try {
      if (signal?.aborted) throw cancellationError("embedding isolate daemon start");
      const started = input.start(abort.signal);
      void started.then(
        (handle) => {
          if (this.daemons.has(handle) || abort.signal.aborted === false) return;
          void handle.shutdown().catch(() => undefined);
        },
        () => undefined
      );
      const handle = await Promise.race([started, waitForAbort(abort.signal)]);
      this.daemons.add(handle);
      return handle;
    } catch (error) {
      abort.abort(error instanceof Error ? error : timeoutError(timeoutMs, "embedding isolate daemon start"));
      await this.reapDaemons();
      this.failIsolate(classifyStartFailure(error), error);
    } finally {
      clearTimeout(timer);
      stopParent();
    }
  }

  private async shutdownHandle(handle: EmbeddingIsolateDaemonHandle): Promise<void> {
    try {
      await handle.shutdown();
      this.daemons.delete(handle);
    } catch (error) {
      this.failIsolate("uncertain", error);
    }
  }

  private async reapDaemons(): Promise<void> {
    const running = [...this.daemons];
    this.daemons.clear();
    await Promise.all(running.map((handle) => handle.shutdown().catch(() => undefined)));
  }

  private failIsolate(reason: EmbeddingIsolateFailClosedReason, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    if (this.session.isDead) {
      throw this.session.deadReason === null
        ? new EmbeddingIsolateFailClosedError(reason, message)
        : new EmbeddingIsolateFailClosedError(this.session.deadReason, message);
    }
    this.session.failClosed(reason, message);
  }
}

export function createEmbeddingIsolateDaemonAdapter(input: {
  readonly session: EmbeddingIsolateSession;
  readonly timeoutMs?: number;
}): EmbeddingIsolateDaemonAdapter {
  return new EmbeddingIsolateDaemonAdapter(input);
}

function classifyStartFailure(error: unknown): EmbeddingIsolateFailClosedReason {
  if (error instanceof EmbeddingIsolateFailClosedError) return error.reason;
  if (isTimeoutError(error)) return "timeout";
  if (isAbortError(error)) return "cancellation";
  return "daemon-start-failure";
}
