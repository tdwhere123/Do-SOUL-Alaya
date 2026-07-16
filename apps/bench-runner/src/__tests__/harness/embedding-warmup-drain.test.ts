import { describe, expect, it } from "vitest";
import {
  awaitBenchEmbeddingProviderReady,
  drainEmbeddingWarmupPasses,
  formatEmbeddingWarmupNotReadyError
} from "../../harness/embedding-warmup.js";
import {
  embeddingWarmupSummary as summaryFrom,
  registerEmbeddingWarmupCleanup
} from "./embedding-warmup-fixture.js";

registerEmbeddingWarmupCleanup();

describe("drainEmbeddingWarmupPasses", () => {
  it("reaches all-ready as soon as one backfill pass drains the workspace, well under the maxPasses ceiling", async () => {
    // Targeted warmup pass: each runPass drains only EMBEDDING_BACKFILL for the
    // workspace, so when the backfill provider succeeds the O(n) handler reaches
    // readiness without competing Librarian maintenance kinds.
    const expected = 50;
    const slotLandsBackfillOnPass = 3;
    let ready = 0;
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 10,
      maxStallPasses: 10,
      runPass: async () => {
        passes += 1;
        if (passes === slotLandsBackfillOnPass) {
          ready = expected;
        }
      },
      readSummary: async (passCount) => summaryFrom(expected, ready, passCount)
    });

    expect(result.summary.ready_count).toBe(expected);
    expect(result.summary.pass_count).toBe(slotLandsBackfillOnPass);
    expect(passes).toBe(slotLandsBackfillOnPass);
    expect(result.lastPassError).toBeNull();
  });

  it("resets the stall budget whenever a pass advances ready_count so a multi-step drain finishes", async () => {
    // A drip drain that advances ready_count one step on every odd pass and
    // stalls on the intervening even pass. maxStallPasses=2 tolerates a single
    // stall between progress steps; the reset on each productive pass keeps the
    // accumulated stall count from ever reaching the budget. A loop that did
    // NOT reset would accumulate 3 total stalls across the run and give up
    // before reaching expected.
    const expected = 4;
    let ready = 0;
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 100,
      maxStallPasses: 2,
      runPass: async () => {
        passes += 1;
        if (passes % 2 === 1 && ready < expected) {
          ready += 1;
        }
      },
      readSummary: async (passCount) => summaryFrom(expected, ready, passCount)
    });

    expect(result.summary.ready_count).toBe(expected);
    // 4 productive (odd) passes + up to 3 interleaved stalls, far under maxPasses.
    expect(result.summary.pass_count).toBeLessThan(100);
  });

  it("terminates at the stall budget when no pass ever makes progress", async () => {
    // A genuinely stuck embedding (slot never lands on backfill, or backfill
    // never succeeds) must terminate at the bounded stall budget rather than
    // spinning to the maxPasses ceiling.
    const expected = 5;
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 1000,
      maxStallPasses: 6,
      runPass: async () => {
        passes += 1;
      },
      readSummary: async (passCount) => summaryFrom(expected, 0, passCount)
    });

    expect(result.summary.ready_count).toBe(0);
    expect(passes).toBe(6);
    expect(passes).toBeLessThan(1000);
  });

  it("records the last pass error when runPass throws and the cache never readies", async () => {
    const expected = 2;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 4,
      maxStallPasses: 4,
      runPass: async () => {
        throw new Error("garden pass exploded");
      },
      readSummary: async (passCount) => summaryFrom(expected, 0, passCount)
    });

    expect(result.summary.ready_count).toBe(0);
    expect(result.lastPassError).toContain("garden pass exploded");
  });

  it("includes provider/root backfill reason in the final not-ready error", async () => {
    const expected = 2;
    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 4,
      maxStallPasses: 4,
      runPass: async () => {
        throw new Error("embedding_backfill_skipped:provider_unavailable");
      },
      readSummary: async (passCount) => ({
        ...summaryFrom(expected, 0, passCount),
        missing_object_ids: ["memory-a", "memory-b"]
      })
    });

    expect(formatEmbeddingWarmupNotReadyError(result.summary, result.lastPassError)).toContain(
      "last_error=embedding_backfill_skipped:provider_unavailable"
    );
  });

  it("does not run any pass when the cache is already fully warm", async () => {
    const expected = 3;
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 10,
      maxStallPasses: 10,
      runPass: async () => {
        passes += 1;
      },
      readSummary: async (passCount) => summaryFrom(expected, expected, passCount)
    });

    expect(passes).toBe(0);
    expect(result.summary.ready_count).toBe(expected);
  });
});

describe("awaitBenchEmbeddingProviderReady", () => {
  it("awaits the runtime warmup promise before declaring the provider ready", async () => {
    let resolveWarmup: (status: "ready") => void = () => undefined;
    const providerWarmup = new Promise<"ready">((resolve) => { resolveWarmup = resolve; });
    let settled = false;

    const barrier = awaitBenchEmbeddingProviderReady({
      embeddingMode: "env",
      providerWarmup
    });
    void barrier.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    resolveWarmup("ready");
    await expect(barrier).resolves.toBeUndefined();
  });

  it("fails closed when the runtime provider warmup fails", async () => {
    await expect(awaitBenchEmbeddingProviderReady({
      embeddingMode: "env",
      providerWarmup: Promise.resolve("failed")
    })).rejects.toThrow(/status=failed/u);
  });

  it("fails closed when an enabled cell has no provider to warm", async () => {
    await expect(awaitBenchEmbeddingProviderReady({
      embeddingMode: "env",
      providerWarmup: Promise.resolve("not_requested")
    })).rejects.toThrow(/status=not_requested/u);
  });

  it("does not await provider warmup for disabled A/C cells", async () => {
    const providerWarmup = new Promise<"ready">(() => undefined);
    await expect(awaitBenchEmbeddingProviderReady({
      embeddingMode: "disabled",
      providerWarmup
    })).resolves.toBeUndefined();
  });
});
