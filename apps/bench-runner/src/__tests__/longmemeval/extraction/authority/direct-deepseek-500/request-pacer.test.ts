import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFreshDirectDeepSeek500Authorization
} from "../../../../../longmemeval/extraction/authority/direct-deepseek-500.js";
import { createRequestStartPacer } from
  "../../../../../longmemeval/extraction/authority/direct-deepseek-500/request-pacer.js";
import { openDirectDeepSeekRequestStartState } from
  "../../../../../longmemeval/extraction/authority/direct-deepseek-500/request-start-state.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("direct DeepSeek request pacer", () => {
  it("serializes concurrent request starts below the 30 RPM ceiling", async () => {
    let now = 0;
    const delays: number[] = [];
    const { cacheRoot, authorization } = createPacerRoot();
    const pacer = createRequestStartPacer({
      requestsPerMinute: 30,
      state: openDirectDeepSeekRequestStartState({ cacheRoot, authorization }),
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      }
    });

    await Promise.all(Array.from({ length: 3 }, async () => await pacer.wait()));

    expect(delays).toEqual([2_001, 2_001]);
    expect(now).toBe(4_002);
  });

  it("does not consume a start interval when an already-aborted caller waits", async () => {
    let now = 0;
    const { cacheRoot, authorization } = createPacerRoot();
    const pacer = createRequestStartPacer({
      requestsPerMinute: 30,
      state: openDirectDeepSeekRequestStartState({ cacheRoot, authorization }),
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      }
    });
    const controller = new AbortController();
    controller.abort(new Error("operator stopped"));

    await expect(pacer.wait(controller.signal)).rejects.toThrow(/operator stopped/u);
    await pacer.wait();

    expect(now).toBe(0);
  });

  it("keeps a later caller behind a predecessor when a middle caller aborts", async () => {
    let now = 0;
    const pendingSleeps: Array<{ readonly milliseconds: number; readonly resolve: () => void }> = [];
    const { cacheRoot, authorization } = createPacerRoot();
    const pacer = createRequestStartPacer({
      requestsPerMinute: 30,
      state: openDirectDeepSeekRequestStartState({ cacheRoot, authorization }),
      now: () => now,
      sleep: async (milliseconds) => await new Promise<void>((resolve) => {
        pendingSleeps.push({ milliseconds, resolve });
      })
    });
    await pacer.wait();

    const first = pacer.wait();
    await waitForSleep(pendingSleeps, 1);
    const controller = new AbortController();
    const middle = pacer.wait(controller.signal);
    controller.abort(new Error("operator stopped"));
    await expect(middle).rejects.toThrow(/operator stopped/u);

    let laterStarted = false;
    const later = pacer.wait().then(() => {
      laterStarted = true;
    });
    expect(laterStarted).toBe(false);

    now += pendingSleeps[0]!.milliseconds;
    pendingSleeps[0]!.resolve();
    await first;
    await waitForSleep(pendingSleeps, 2);

    expect(laterStarted).toBe(false);
    expect(pendingSleeps[1]!.milliseconds).toBe(2_001);
    now += pendingSleeps[1]!.milliseconds;
    pendingSleeps[1]!.resolve();
    await later;

    expect(laterStarted).toBe(true);
  });

  it("retains the last request start when a direct fill resumes", async () => {
    let now = 0;
    const delays: number[] = [];
    const { cacheRoot, authorization } = createPacerRoot();
    const sleep = async (milliseconds: number) => {
      delays.push(milliseconds);
      now += milliseconds;
    };
    await createRequestStartPacer({
      requestsPerMinute: 30,
      state: openDirectDeepSeekRequestStartState({ cacheRoot, authorization }),
      now: () => now,
      sleep
    }).wait();

    await createRequestStartPacer({
      requestsPerMinute: 30,
      state: openDirectDeepSeekRequestStartState({ cacheRoot, authorization }),
      now: () => now,
      sleep
    }).wait();

    expect(delays).toEqual([2_001]);
    expect(now).toBe(2_001);
  });
});

function createPacerRoot() {
  const root = mkdtempSync(join(tmpdir(), "deepseek-request-pacer-"));
  temporaryRoots.push(root);
  const cacheRoot = join(root, "cache");
  const authorization = createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "request-pacer-test"
  });
  return { cacheRoot, authorization };
}

async function waitForSleep(
  pendingSleeps: readonly unknown[],
  expectedCount: number
): Promise<void> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (pendingSleeps.length >= expectedCount) return;
    await Promise.resolve();
  }
  throw new Error(`expected ${expectedCount} pending pace sleeps`);
}
