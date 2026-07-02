import { describe, expect, it } from "vitest";
import type { KpiPayload } from "../../schema/kpi-schema.js";
import { attributeSeedDrops } from "../../reporting/report-absolute-kpis.js";

function makeSeedExtractionPath(
  input: Partial<NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>> = {}
): NonNullable<KpiPayload["kpi"]["seed_extraction_path"]> {
  return {
    path: "official_api_compile",
    cache_hits: 0,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 0,
    signals_dropped: 0,
    parse_dropped: 0,
    compile_overflow_dropped: 0,
    signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 },
    ...input
  };
}

describe("attributeSeedDrops", () => {
  it("counts governance-declined signals as declined, not as a batch failure", () => {
    // LoCoMo 1982 re-baseline shape: all but the parser drops are candidate_absent.
    const drops = attributeSeedDrops(
      makeSeedExtractionPath({
        signals_dropped: 1705,
        parse_dropped: 18,
        compile_overflow_dropped: 0,
        signals_dropped_by_reason: { candidate_absent: 1687, materialization_drop: 0 }
      })
    );
    expect(drops.declined).toBe(1687);
    expect(drops.parseDropped).toBe(18);
    expect(drops.materializationDrop).toBe(0);
    expect(drops.batchResidual).toBe(0);
    expect(drops.trulyLost).toBe(18);
  });

  it("attributes materialization errors and an unattributed batch residual to the lost count", () => {
    const drops = attributeSeedDrops(
      makeSeedExtractionPath({
        signals_dropped: 10,
        parse_dropped: 1,
        compile_overflow_dropped: 0,
        signals_dropped_by_reason: { candidate_absent: 2, materialization_drop: 3 }
      })
    );
    expect(drops.declined).toBe(2);
    expect(drops.materializationDrop).toBe(3);
    expect(drops.batchResidual).toBe(4); // 10 - 1 - 0 - 2 - 3
    expect(drops.trulyLost).toBe(8); // 1 + 0 + 3 + 4
  });

  it("keeps declined + trulyLost summing to signals_dropped", () => {
    const path = makeSeedExtractionPath({
      signals_dropped: 30,
      parse_dropped: 2,
      compile_overflow_dropped: 1,
      signals_dropped_by_reason: { candidate_absent: 20, materialization_drop: 5 }
    });
    const drops = attributeSeedDrops(path);
    expect(drops.declined + drops.trulyLost).toBe(path.signals_dropped);
  });

  it("accepts legacy materialization_error archives via schema normalization", () => {
    const path = makeSeedExtractionPath({
      signals_dropped: 8,
      parse_dropped: 1,
      compile_overflow_dropped: 0,
      signals_dropped_by_reason: {
        candidate_absent: 2,
        materialization_drop: 0,
        materialization_error: 3
      } as unknown as NonNullable<
        KpiPayload["kpi"]["seed_extraction_path"]
      >["signals_dropped_by_reason"]
    });
    // attributeSeedDrops reads the normalized in-memory shape; legacy key is
    // only relevant at KPI parse time. Simulate the normalized output here.
    const drops = attributeSeedDrops({
      ...path,
      signals_dropped_by_reason: { candidate_absent: 2, materialization_drop: 3 }
    });
    expect(drops.materializationDrop).toBe(3);
    expect(drops.batchResidual).toBe(2);
  });
});
