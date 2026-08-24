import type {
  BenchDaemonHandle,
  BenchWorkspaceHandle
} from "../../../../harness/daemon.js";

export interface RecallEvalWorkspaceIdentity {
  readonly workspaceId: string;
  readonly runId: string;
}

export class RecallEvalWorkspaceSession {
  private attached: {
    readonly identity: RecallEvalWorkspaceIdentity;
    readonly handle: BenchWorkspaceHandle;
  } | null = null;

  public async acquire(
    daemon: Pick<BenchDaemonHandle, "attachWorkspace">,
    identity: RecallEvalWorkspaceIdentity
  ): Promise<BenchWorkspaceHandle> {
    if (this.attached !== null && sameIdentity(this.attached.identity, identity)) {
      return this.attached.handle;
    }
    await this.release();
    const handle = await daemon.attachWorkspace(identity);
    this.attached = { identity, handle };
    return handle;
  }

  public async release(): Promise<void> {
    const current = this.attached;
    this.attached = null;
    await current?.handle.detach();
  }
}

function sameIdentity(
  left: RecallEvalWorkspaceIdentity,
  right: RecallEvalWorkspaceIdentity
): boolean {
  return left.workspaceId === right.workspaceId && left.runId === right.runId;
}
