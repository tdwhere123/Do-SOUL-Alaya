import { expect, it } from "vitest";
import type { KpiPayload } from "../../schema/kpi-schema.js";
import {
  collectReleaseHardGates,
  releaseHardGateAllowsLatestPassing
} from "../../gates/release-gates.js";
import {
  evaluateSeedExtractionReleaseBlocker,
  isCacheOnlySeedExtractionPath
} from "../../gates/seed-extraction-blocker.js";
import {
  buildLocomoPayload,
  buildReleaseGradePublic,
  makeSeedExtractionPath
} from "./release-gates-fixture.js";

it("blocks degraded seed extraction after numeric and measurement gates pass", () => {
  const payload = buildReleaseGradePublic(makeSeedExtractionPath({
    path: "no_credentials_fallback",
    cache_hits: 0,
    offline_fallbacks: 8
  }));

  expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
  expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
});

it("accepts clean seed extraction while verified evidence remains required", () => {
  const payload = buildReleaseGradePublic(makeSeedExtractionPath());

  expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
  expect(evaluateSeedExtractionReleaseBlocker(payload)).toBeNull();
  expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
});

it("blocks live extraction calls from cache-only release evidence", () => {
  const payload = buildReleaseGradePublic(makeSeedExtractionPath({ llm_calls: 1 }));

  expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
  expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
});

it.each([
  ["llm_calls", { llm_calls: 1 }],
  ["offline_fallbacks", { offline_fallbacks: 1 }],
  ["live_extraction_failures", { live_extraction_failures: 1 }],
  ["cached_extraction_failures", { cached_extraction_failures: 1 }]
] as const)("rejects non-cache-only %s provenance consistently", (_field, override) => {
  const path = makeSeedExtractionPath(override);
  const payload = buildReleaseGradePublic(path);

  expect(isCacheOnlySeedExtractionPath(path)).toBe(false);
  expect(evaluateSeedExtractionReleaseBlocker(payload)).not.toBeNull();
  expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
});

it.each([
  ["missing attempts", { extraction_attempts: undefined }],
  ["zero attempts", { extraction_attempts: 0, cache_hits: 0 }],
  ["cache-hit mismatch", { extraction_attempts: 276, cache_hits: 275 }],
  ["zero facts", { facts_produced: 0 }],
  ["drop mismatch", { signals_dropped: 5 }]
] as const)("rejects non-substantive or inconsistent cache proof: %s", (_name, override) => {
  const path = makeSeedExtractionPath(override);
  expect(isCacheOnlySeedExtractionPath(path)).toBe(false);
  expect(evaluateSeedExtractionReleaseBlocker(
    buildReleaseGradePublic(path)
  )).not.toBeNull();
});

it.each([
  ["longmemeval_s_no_gold", { no_gold_count: 1 }],
  ["longmemeval_s_evaluator_identity_issue", { evaluator_identity_issue_count: 1 }]
])("fails the %s hard gate independently of candidate absence", (gateId, override) => {
  const current = buildReleaseGradePublic(makeSeedExtractionPath());
  const payload = {
    ...current,
    kpi: {
      ...current.kpi,
      quality_metrics: {
        ...current.kpi.quality_metrics,
        candidate_absent_count: 0,
        ...override
      }
    }
  } as KpiPayload;

  expect(collectReleaseHardGates(payload)).toContainEqual(
    expect.objectContaining({ id: gateId, passed: false, target: 0 })
  );
  expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
});

it("blocks missing seed extraction after numeric and measurement gates pass", () => {
  const payload = buildReleaseGradePublic();
  expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
  expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
});

it("keeps missing seed extraction backward-compatible for LoCoMo", () => {
  expect(releaseHardGateAllowsLatestPassing(buildLocomoPayload(1982, 1982, 0.56)))
    .toBe(true);
});

it("blocks an explicitly degraded seed path on a future non-LongMem bench", () => {
  const base = buildLocomoPayload(1982, 1982, 0.95);
  const payload: KpiPayload = {
    ...base,
    kpi: {
      ...base.kpi,
      seed_extraction_path: makeSeedExtractionPath({
        offline_fallbacks: 3,
        live_extraction_failures: 3
      })
    }
  };

  expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
  expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
});
