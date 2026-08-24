import { describe, expect, it, vi } from "vitest";
import type { BenchDaemonHandle } from "../../../harness/daemon.js";
import { RecallEvalWorkspaceSession } from
  "../../../bench/lifecycle/recall-eval/question/recall-eval-workspace-session.js";

interface FakeWorkspaceHandle {
  readonly workspaceId: string;
  readonly runId: string;
  readonly detach: ReturnType<typeof vi.fn>;
}

describe("recall-eval workspace session", () => {
  it("keeps one attached workspace while identity is unchanged", async () => {
    const { daemon, attach, handles } = fakeDaemon();
    const session = new RecallEvalWorkspaceSession();

    const first = await session.acquire(daemon, identity("ws-a", "run-a"));
    const second = await session.acquire(daemon, identity("ws-a", "run-a"));

    expect(attach).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(handles[0]?.detach).not.toHaveBeenCalled();

    await session.release();
    expect(handles[0]?.detach).toHaveBeenCalledTimes(1);
  });

  it("detaches before attaching a different workspace identity", async () => {
    const { daemon, attach, handles } = fakeDaemon();
    const session = new RecallEvalWorkspaceSession();

    await session.acquire(daemon, identity("ws-a", "run-a"));
    await session.acquire(daemon, identity("ws-b", "run-b"));

    expect(attach).toHaveBeenCalledTimes(2);
    expect(handles[0]?.detach).toHaveBeenCalledTimes(1);
    expect(handles[1]?.detach).not.toHaveBeenCalled();

    await session.release();
    expect(handles[1]?.detach).toHaveBeenCalledTimes(1);
  });
});

function identity(workspaceId: string, runId: string) {
  return { workspaceId, runId };
}

function fakeDaemon(): {
  readonly daemon: Pick<BenchDaemonHandle, "attachWorkspace">;
  readonly attach: ReturnType<typeof vi.fn>;
  readonly handles: FakeWorkspaceHandle[];
} {
  const handles: FakeWorkspaceHandle[] = [];
  const attach = vi.fn(async (input: { readonly workspaceId: string; readonly runId: string }) => {
    const handle: FakeWorkspaceHandle = {
      workspaceId: input.workspaceId,
      runId: input.runId,
      detach: vi.fn(async () => undefined)
    };
    handles.push(handle);
    return handle;
  });
  return {
    daemon: { attachWorkspace: attach },
    attach,
    handles
  };
}
