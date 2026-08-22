import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecallEvalPagerChildExitedError,
  createForkRecallEvalPagerHost,
  createRecallEvalPagerSession
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

  it("fail-closes when the child exits mid-request", async () => {
    const session = openSession();
    await session.open({});
    await expect(session.recall({ questionId: "__crash__" })).rejects.toMatchObject({
      name: "RecallEvalPagerChildExitedError",
      code: 7
    });
    await expect(session.recall({ questionId: "ok" })).rejects.toBeInstanceOf(
      RecallEvalPagerChildExitedError
    );
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

  function openSession(timeoutMs?: number) {
    const session = createRecallEvalPagerSession({
      host: createForkRecallEvalPagerHost(stubChildPath),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    sessions.push(session);
    return session;
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
