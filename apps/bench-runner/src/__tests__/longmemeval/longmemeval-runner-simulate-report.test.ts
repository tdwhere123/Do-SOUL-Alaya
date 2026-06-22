import { createHash } from "node:crypto";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";

import { LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME } from "../../longmemeval/archive-evidence.js";

import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";

import { runLongMemEvalMultiturn } from "../../longmemeval/multiturn.js";

import { runLongMemEvalCrossQuestion } from "../../longmemeval/crossquestion.js";

import {
  buildLongMemEvalSidecarKey,
  buildLongMemEvalReportContextUsage,
  deriveLongMemEvalGoldMemoryIds,
  resolveBenchEmbeddingProviderLabel,
  runLongMemEval,
  runLongMemEvalRecallCycle,
  scoreLongMemEvalRecallHits
} from "../../longmemeval/runner.js";

import { buildRecallResult } from "./longmemeval-runner-fixture.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lme-test-"));
  // These runs take the no-credentials offline seed path; the model value is
  // never used for a live call. Each run below passes an isolated
  // extractionCacheRoot (no manifest -> first-ever-build preflight), so this
  // model is arbitrary and the tests are decoupled from the production
  // extraction-cache manifest's model.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("LongMemEval runner", () => {

  it("builds simulate-report usage from delivered results only", () => {
    const delivered = [
      { object_id: "decoy-top", relevance_score: 0.9 },
      { object_id: "gold-delivered", relevance_score: 0.8 },
      { object_id: "decoy-tail", relevance_score: 0.7 }
    ];

    expect(
      buildLongMemEvalReportContextUsage({
        simulateReport: "none",
        deliveryId: "delivery-1",
        results: delivered,
        goldMemoryIds: ["gold-delivered"],
        turnIndex: 3,
        questionText: "Which memory was used?"
      }).reportInput
    ).toBeNull();

    const goldOnly = buildLongMemEvalReportContextUsage({
      simulateReport: "gold-only",
      deliveryId: "delivery-2",
      results: delivered,
      goldMemoryIds: ["gold-delivered", "gold-not-delivered"],
      turnIndex: 3,
      questionText: "Which memory was used?"
    });
    expect(goldOnly.reportInput?.usageState).toBe("used");
    expect(goldOnly.reportInput?.usedObjectIds).toEqual(["gold-delivered"]);
    expect(goldOnly.reportInput?.deliveredObjects).toEqual([
      { objectId: "decoy-top", objectKind: "memory_entry", usageStatus: "skipped" },
      { objectId: "gold-delivered", objectKind: "memory_entry", usageStatus: "used" },
      { objectId: "decoy-tail", objectKind: "memory_entry", usageStatus: "skipped" }
    ]);

    const mixedFallback = buildLongMemEvalReportContextUsage({
      simulateReport: "mixed",
      deliveryId: "delivery-3",
      results: delivered,
      goldMemoryIds: ["gold-not-delivered"],
      turnIndex: 4,
      questionText: "Which fallback was used?"
    });
    expect(mixedFallback.reportInput?.usageState).toBe("used");
    expect(mixedFallback.reportInput?.usedObjectIds).toEqual(["decoy-top"]);

    const synthesisCollision = buildLongMemEvalReportContextUsage({
      simulateReport: "gold-only",
      deliveryId: "delivery-synthesis-collision",
      results: [
        {
          object_id: "gold-delivered",
          object_kind: "synthesis_capsule"
        }
      ],
      goldMemoryIds: ["gold-delivered"],
      turnIndex: 4,
      questionText: "Which memory was used?"
    });
    expect(synthesisCollision.reportInput?.usageState).toBe("skipped");
    expect(synthesisCollision.reportInput?.usedObjectIds).toBeUndefined();

    const mixedSynthesisOnly = buildLongMemEvalReportContextUsage({
      simulateReport: "mixed",
      deliveryId: "delivery-mixed-synthesis",
      results: [
        {
          object_id: "shared-object",
          object_kind: "synthesis_capsule"
        }
      ],
      goldMemoryIds: ["other-gold"],
      turnIndex: 4,
      questionText: "Which fallback was used?"
    });
    expect(mixedSynthesisOnly.reportInput?.usageState).toBe("skipped");
    expect(mixedSynthesisOnly.reportInput?.usedObjectIds).toBeUndefined();

    const alwaysUsedSynthesisOnly = buildLongMemEvalReportContextUsage({
      simulateReport: "always-used",
      deliveryId: "delivery-always-synthesis",
      results: [
        {
          object_id: "shared-object",
          object_kind: "synthesis_capsule"
        }
      ],
      goldMemoryIds: ["other-gold"],
      turnIndex: 4,
      questionText: "Which fallback was used?"
    });
    expect(alwaysUsedSynthesisOnly.reportInput?.usageState).toBe("skipped");
    expect(alwaysUsedSynthesisOnly.reportInput?.usedObjectIds).toBeUndefined();

    const skippedGoldOnly = buildLongMemEvalReportContextUsage({
      simulateReport: "gold-only",
      deliveryId: "delivery-4",
      results: delivered,
      goldMemoryIds: ["gold-not-delivered"],
      turnIndex: 5,
      questionText: "Was gold delivered?"
    });
    expect(skippedGoldOnly.reportInput?.usageState).toBe("skipped");
    expect(skippedGoldOnly.reportInput?.usedObjectIds).toBeUndefined();
    expect(skippedGoldOnly.reportInput?.deliveredObjects?.every(
      (item) => item.usageStatus === "skipped"
    )).toBe(true);

    const alwaysUsedEmpty = buildLongMemEvalReportContextUsage({
      simulateReport: "always-used",
      deliveryId: "delivery-5",
      results: [],
      goldMemoryIds: ["gold-not-delivered"],
      turnIndex: 6,
      questionText: "No results?"
    });
    expect(alwaysUsedEmpty.reportInput?.usageState).toBe("skipped");
    expect(alwaysUsedEmpty.reportInput?.deliveredObjects).toEqual([]);
    expect(alwaysUsedEmpty.stats).toEqual({
      reportsAttempted: 1,
      reportsUsed: 0,
      reportsSkipped: 1,
      usedObjectCount: 0
    });
  });

  it("uses a pre-report recall before the scored recall for simulate_report warm modes", async () => {
    const recall = vi
      .fn()
      .mockResolvedValueOnce(buildRecallResult("delivery-pre", ["gold", "decoy"]))
      .mockResolvedValueOnce(buildRecallResult("delivery-scored", ["decoy", "gold"]));
    const reportContextUsage = vi.fn().mockResolvedValue(undefined);

    const result = await runLongMemEvalRecallCycle({
      daemon: { recall, reportContextUsage },
      query: "Which memory was used?",
      recallOptions: { maxResults: 10, conflictAwareness: true },
      simulateReport: "mixed",
      goldMemoryIds: ["gold"],
      turnIndex: 7,
      questionText: "Which memory was used?"
    });

    expect(recall).toHaveBeenCalledTimes(2);
    expect(reportContextUsage).toHaveBeenCalledTimes(1);
    expect(reportContextUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-pre",
        usedObjectIds: ["gold", "decoy"]
      })
    );
    expect(result.scoredRecallResult.delivery_id).toBe("delivery-scored");
    expect(result.scoredRecallResult.results[0]?.object_id).toBe("decoy");
    expect(result.reportUsageStats).toMatchObject({
      reportsAttempted: 1,
      reportsUsed: 1,
      usedObjectCount: 2
    });
  });

  it("keeps simulate_report=none as a single scored recall", async () => {
    const recall = vi
      .fn()
      .mockResolvedValueOnce(buildRecallResult("delivery-scored", ["gold"]));
    const reportContextUsage = vi.fn().mockResolvedValue(undefined);

    const result = await runLongMemEvalRecallCycle({
      daemon: { recall, reportContextUsage },
      query: "Which memory was used?",
      recallOptions: { maxResults: 10, conflictAwareness: true },
      simulateReport: "none",
      goldMemoryIds: ["gold"],
      turnIndex: 8,
      questionText: "Which memory was used?"
    });

    expect(recall).toHaveBeenCalledTimes(1);
    expect(reportContextUsage).not.toHaveBeenCalled();
    expect(result.scoredRecallResult.delivery_id).toBe("delivery-scored");
    expect(result.reportUsageStats.reportsAttempted).toBe(0);
  });

  // Guards KpiPayloadSchema's latency_ms* nonnegative() invariant: a
  // monotonic recall clock can never report a negative duration even when
  // recall resolves instantly. see also: packages/eval/src/schema/kpi-schema.ts.
  it.each(["none", "mixed"] as const)(
    "reports a non-negative finite scoredRecallLatencyMs for simulate_report=%s",
    async (simulateReport) => {
      const recall = vi
        .fn()
        .mockResolvedValue(buildRecallResult("delivery-scored", ["gold"]));
      const reportContextUsage = vi.fn().mockResolvedValue(undefined);

      const result = await runLongMemEvalRecallCycle({
        daemon: { recall, reportContextUsage },
        query: "Which memory was used?",
        recallOptions: { maxResults: 10, conflictAwareness: true },
        simulateReport,
        goldMemoryIds: ["gold"],
        turnIndex: 9,
        questionText: "Which memory was used?"
      });

      expect(Number.isFinite(result.scoredRecallLatencyMs)).toBe(true);
      expect(result.scoredRecallLatencyMs).toBeGreaterThanOrEqual(0);
    }
  );
});
