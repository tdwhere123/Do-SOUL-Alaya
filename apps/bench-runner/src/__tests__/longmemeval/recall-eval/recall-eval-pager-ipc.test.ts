import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecallEvalPagerChildExitedError,
  createForkRecallEvalPagerHost,
  createRecallEvalPagerSession,
  type RecallEvalPagerIpcHost
} from "../../../runs/lifecycle/recall-eval/recall-eval-process/ipc-client.js";

const stubChildPath = fileURLToPath(
  new URL("./recall-eval-pager-ipc-stub-child.mjs", import.meta.url)
);

describe("recall-eval pager IPC isolation", () => {
  const sessions: ReturnType<typeof createRecallEvalPagerSession>[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    const pending = sessions.splice(0);
    await Promise.all(pending.map((session) => session.close().catch(() => undefined)));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("returns a pack from the child without mapping sqlite in the parent", async () => {
    const session = openSession();
    await session.open({});
    const pack = await session.recall({ questionId: "ok" }) as { readonly questionId: string };
    expect(pack.questionId).toBe("ok");
    expect(parentMapsAlayaDb()).toBe(false);
  });

  it("reuses the same child pid across questions", async () => {
    const counted = countingHost();
    const session = openSession(undefined, counted.host);
    await session.open({});
    expect(counted.pids).toHaveLength(1);
    await session.recall({ questionId: "q1" });
    await session.recall({ questionId: "q2" });
    expect(counted.pids).toHaveLength(1);
    expect(counted.pids[0]).toBe(session.pid);
  });

  it("preserves budget, continuation, cancellation and interpretation fields across IPC", async () => {
    const session = openSession();
    await session.open({});
    const recallOptions = {
      budget: { schema_version: 1, work_units: 1000, memory_bytes: 65536, page_budget: 1,
        finalization_reserve: 100, min_envelope: 10 },
      continuation: { schema_version: 1, continuation_id: "next", query_id: "query",
        snapshot_id: `sha256:${"a".repeat(64)}`, result_version: "v1", cursor: "cursor",
        expires_at: "2099-01-01T00:00:00.000Z", interpretation_clock: "2026-09-06T00:00:00.000Z" },
      cancelled: true, interpretationClock: "2026-09-06T00:00:00.000Z",
      timeFilter: { field: "created_at", since: "2020-01-01T00:00:00.000Z" }
    };
    const pack = await session.recall({ questionId: "page", recallOptions }) as { recallOptions: unknown };
    expect(pack.recallOptions).toEqual(recallOptions);
  });

  it("rejects continuation after recycle before respawning a process", async () => {
    const counted = countingHost();
    const session = openSession(undefined, counted.host);
    await session.open({});
    await session.recall({ questionId: "q1" });
    await session.recycle();
    await expect(session.recall({ questionId: "q1", recallOptions: { continuation: { cursor: "old" } } }))
      .rejects.toThrow(/continuation invalidated/);
    expect(counted.pids).toHaveLength(1);
  });

  it("spawns a new child for each recycled question", async () => {
    const counted = countingHost();
    const session = openSession(undefined, counted.host);
    await session.open({});
    await session.recall({ questionId: "q1" });
    await session.recycle();
    await session.recall({ questionId: "q2" });
    await session.recycle();
    expect(counted.pids).toHaveLength(2);
    expect(new Set(counted.pids).size).toBe(2);
    await session.close();
    expect(counted.pids).toHaveLength(2);
  });

  it("fail-closes when the child exits mid-request", async () => {
    const counted = countingHost();
    const session = openSession(undefined, counted.host);
    await session.open({});
    await expect(session.recall({ questionId: "__crash__" })).rejects.toMatchObject({
      name: "RecallEvalPagerChildExitedError",
      code: 7
    });
    const spawnsAfterCrash = counted.pids.length;
    await expect(session.recall({ questionId: "ok" })).rejects.toBeInstanceOf(
      RecallEvalPagerChildExitedError
    );
    expect(counted.pids).toHaveLength(spawnsAfterCrash);
  });

  it("fail-closes when spawn throws and does not retry", async () => {
    let spawns = 0;
    const session = openSession(undefined, {
      spawn() {
        spawns += 1;
        throw new Error("synthetic spawn failure");
      }
    });
    await expect(session.open({})).rejects.toBeInstanceOf(RecallEvalPagerChildExitedError);
    await expect(session.recall({ questionId: "ok" })).rejects.toBeInstanceOf(
      RecallEvalPagerChildExitedError
    );
    expect(spawns).toBe(1);
  });

  it("fail-closes when the child never replies", async () => {
    const session = openSession(40);
    await session.open({}, 5_000);
    await expect(session.recall({ questionId: "__hang__" }, 40)).rejects.toThrow(/timed out/u);
  });

  it("treats advancing child work as activity instead of an absolute timeout", async () => {
    const session = openSession(400);
    await expect(session.open({
      progressEveryMs: 120,
      progressCount: 5
    })).resolves.toMatchObject({ ok: true });
  });

  it("does not let duplicate progress mask an inactive child", async () => {
    const session = openSession(120);
    await expect(session.open({
      progressEveryMs: 50,
      progressCount: 5,
      constantProgressSequence: true
    })).rejects.toThrow(/timed out/u);
  });

  it("fail-closes when the child returns an empty pack", async () => {
    const session = openSession();
    await session.open({});
    await expect(session.recall({ questionId: "__empty__" })).rejects.toThrow(/empty pack/u);
  });

  it("delivers a backpressured recall payload instead of treating a full IPC queue as death", async () => {
    const session = openSession();
    await session.open({});
    const pack = await session.recall({
      questionId: "ok",
      bulk: "x".repeat(4 * 1024 * 1024)
    }) as { readonly questionId: string };
    expect(pack.questionId).toBe("ok");
  });

  function openSession(timeoutMs?: number, host?: RecallEvalPagerIpcHost) {
    const session = createRecallEvalPagerSession({
      host: host ?? createForkRecallEvalPagerHost(stubChildPath),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    sessions.push(session);
    return session;
  }

  function countingHost(): {
    readonly pids: number[];
    readonly host: RecallEvalPagerIpcHost;
  } {
    const inner = createForkRecallEvalPagerHost(stubChildPath);
    const pids: number[] = [];
    return {
      pids,
      host: {
        spawn() {
          const child = inner.spawn();
          pids.push(child.pid ?? -1);
          return child;
        }
      }
    };
  }
});

function parentMapsAlayaDb(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /alaya\.db(?:-wal|-shm)?(?:\s|$)/u.test(readFileSync("/proc/self/maps", "utf8"));
  } catch {
    return false;
  }
}
