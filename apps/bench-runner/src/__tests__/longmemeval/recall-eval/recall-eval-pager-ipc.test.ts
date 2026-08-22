import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecallEvalPagerChildExitedError,
  createForkRecallEvalPagerHost,
  createRecallEvalPagerSession,
  type RecallEvalPagerIpcHost
} from "../../../bench/lifecycle/recall-eval/recall-eval-process/ipc-client.js";

const stubChildPath = fileURLToPath(
  new URL("./recall-eval-pager-ipc-stub-child.mjs", import.meta.url)
);

describe("recall-eval pager IPC isolation", () => {
  const sessions: ReturnType<typeof createRecallEvalPagerSession>[] = [];

  afterEach(async () => {
    const pending = sessions.splice(0);
    await Promise.all(pending.map((session) => session.close().catch(() => undefined)));
  });

  it("returns a pack from the child without mapping sqlite in the parent", async () => {
    const session = openSession();
    await session.open({});
    const pack = await session.recall({ questionId: "ok" }) as { readonly questionId: string };
    expect(pack.questionId).toBe("ok");
    expect(parentMapsAlayaDb()).toBe(false);
  });

  it("spawns a fresh child for each question instead of reusing one address space", async () => {
    const counted = countingHost();
    const session = openSession(undefined, counted.host);
    await session.open({});
    expect(counted.pids).toHaveLength(1);
    await session.recall({ questionId: "q1" });
    await session.recall({ questionId: "q2" });
    expect(counted.pids).toHaveLength(2);
    expect(counted.pids[1]).not.toBe(counted.pids[0]);
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

  it("retains the close selection artifact across child recycle", async () => {
    const session = openSession();
    await session.open({});
    await session.recall({ questionId: "artifact" });
    await expect(session.close()).resolves.toEqual({ sourcePath: "selection.json" });
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
