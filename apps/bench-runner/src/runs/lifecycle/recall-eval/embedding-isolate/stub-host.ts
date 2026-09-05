import type { EmbeddingIsolateChild, EmbeddingIsolateHost } from "./session.js";

export interface StubEmbeddingIsolateHost extends EmbeddingIsolateHost {
  readonly killCount: number;
  readonly livePids: readonly number[];
  emitError(error?: Error): void;
}

export function createStubEmbeddingIsolateHost(
  input: { readonly pidStart?: number } = {}
): StubEmbeddingIsolateHost {
  let nextPid = input.pidStart ?? 9100;
  let killCount = 0;
  const live = new Map<number, StubIsolateChild>();
  return {
    spawn() {
      const pid = nextPid;
      nextPid += 1;
      const child = new StubIsolateChild(pid, () => {
        killCount += 1;
        live.delete(pid);
      });
      live.set(pid, child);
      return child;
    },
    get killCount() {
      return killCount;
    },
    get livePids() {
      return [...live.keys()];
    },
    emitError(error?: Error) {
      const child = [...live.values()][0];
      if (child === undefined) {
        throw new Error("stub isolate has no live child to emit error");
      }
      child.emitError(error ?? new Error("stub isolate child error"));
    }
  };
}

class StubIsolateChild implements EmbeddingIsolateChild {
  public readonly pid: number;
  private killed = false;
  private readonly exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly onKill: () => void;

  public constructor(pid: number, onKill: () => void) {
    this.pid = pid;
    this.onKill = onKill;
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.onKill();
    const listeners = [...this.exitListeners];
    queueMicrotask(() => {
      for (const listener of listeners) listener(0, signal);
    });
    return true;
  }

  public on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void)
  ): unknown {
    if (event === "exit") {
      this.exitListeners.push(
        listener as (code: number | null, signal: NodeJS.Signals | null) => void
      );
    } else {
      this.errorListeners.push(listener as (error: Error) => void);
    }
    return this;
  }

  public emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
