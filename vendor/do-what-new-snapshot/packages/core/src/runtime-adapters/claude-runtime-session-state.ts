import {
  type RuntimeCancelResult,
  type RuntimeSessionConfig
} from "@do-what/protocol";

export interface PendingCancelRequest {
  readonly promise: Promise<RuntimeCancelResult>;
  resolve(result: RuntimeCancelResult): void;
  reject(error: Error): void;
}

interface ActiveTurnState {
  cancel?: () => Promise<void>;
  pendingCancel: PendingCancelRequest | null;
}

export class ClaudeRuntimeSessionState {
  private activeTurn: ActiveTurnState | null = null;
  private finished = false;
  private nextSequence = 0;

  public constructor(
    public readonly config: RuntimeSessionConfig,
    public readonly sessionId: string
  ) {}

  public hasFinished(): boolean {
    return this.finished;
  }

  public markFinished(): boolean {
    if (this.finished) {
      return false;
    }

    this.finished = true;
    return true;
  }

  public hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  public beginTurn(): void {
    this.activeTurn = {
      pendingCancel: null
    };
  }

  public clearActiveTurn(): void {
    this.activeTurn = null;
  }

  public getCancel(): (() => Promise<void>) | undefined {
    return this.activeTurn?.cancel;
  }

  public setCancel(cancel: (() => Promise<void>) | undefined): void {
    if (this.activeTurn !== null) {
      this.activeTurn.cancel = cancel;
    }
  }

  public getPendingCancel(): PendingCancelRequest | null {
    return this.activeTurn?.pendingCancel ?? null;
  }

  public ensurePendingCancel(): PendingCancelRequest {
    if (this.activeTurn === null) {
      throw new Error("Cannot create a pending cancel request without an active turn.");
    }

    if (this.activeTurn.pendingCancel === null) {
      this.activeTurn.pendingCancel = createPendingCancelRequest();
    }

    return this.activeTurn.pendingCancel;
  }

  public currentSequence(): number {
    return this.nextSequence;
  }

  public updateSequence(nextSequence: number): void {
    this.nextSequence = nextSequence;
  }
}

function createPendingCancelRequest(): PendingCancelRequest {
  let resolvePromise!: (result: RuntimeCancelResult) => void;
  let rejectPromise!: (error: Error) => void;

  const promise = new Promise<RuntimeCancelResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}
