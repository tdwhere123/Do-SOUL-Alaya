// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_500Q_CLOSED,
  compareF0F2VsCachedF3,
  mapQuestionToDiagnosticStage
} from "../../../bench/diagnostics/stage-attribution/diagnostic-100q.js";
import { CACHED_F3_EXPOSURE_POLICY } from
  "../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import { DIAGNOSTIC_100Q_KPI_PROMOTION } from
  "../../../bench/diagnostics/stage-attribution/exposure/diagnostic-unlock.js";
import { readDiagnostic100QComparisonArtifact } from
  "../../../bench/diagnostics/stage-attribution/exposure/comparison-artifact.js";
import { buildRecallMechanismSplit } from
  "../../../bench/diagnostics/stage-attribution/mechanism/receipt.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposure, row } from "./phase/exposure-receipt-fixture.js";

describe("diagnostic 100Q stage map", () => {
  it("maps the earliest failed stage and keeps 500Q closed", () => {
    expect(DIAGNOSTIC_500Q_CLOSED).toBe(true);
    expect(mapQuestionToDiagnosticStage(row({
      stage: 1, proof: "empty_gold_or_write_loss", miss_taxonomy: "evaluation_or_gold_issue"
    }))).toBe("S0");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 1, proof: "extraction_materialization_drop"
    }))).toBe("S1");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 2, proof: "semantic_factor_formation_rejected"
    }))).toBe("S2");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 2, proof: "semantic_factor_formation_unavailable"
    }))).toBe("S3");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 2, proof: "miss_taxonomy.candidate_absent_with_emitted_gold"
    }))).toBe("S3");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 5, proof: "miss_taxonomy.budget_drop"
    }))).toBe("S4");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 7, hit_at_5: true, proof: "hit_at_5"
    }))).toBe("S5");
  });

  it("compares F0-F2 control with cached-F3 treatment without provider calls", () => {
    const comparison = compareF0F2VsCachedF3({
      control: [
        row({ question_id: "q-improved", stage: 2, proof: "candidate_absent" }),
        row({ question_id: "q-still", stage: 5, proof: "budget_drop" })
      ],
      treatment: [
        row({ question_id: "q-improved", stage: 7, hit_at_5: true, proof: "hit_at_5" }),
        row({ question_id: "q-still", stage: 5, proof: "budget_drop" })
      ],
      treatmentExposure: [
        exposure("q-improved", "exposed", true, {
          control: { stage: "S3", hit_at_5: false },
          treatment: { stage: "S5", hit_at_5: true }
        }),
        exposure("q-still", "exposed", false)
      ]
    });
    expect(comparison.physical_calls).toBe(0);
    expect(comparison.schema_version).toBe(6);
    expect(comparison.five_hundred_q_closed).toBe(true);
    expect(comparison.membership_improved).toEqual(["q-improved"]);
    expect(comparison.still_missing).toEqual(["q-still"]);
    expect(comparison.not_exercised).toEqual([]);
    expect(comparison.inconclusive).toEqual([]);
    expect(comparison.exposure_sli).toMatchObject({
      denominator_kind: "formed_osf_answerable",
      denominator_count: 2,
      exposed_count: 2,
      rate: 1
    });
    expect(comparison.diagnostic_100q_unlock.eligible).toBe(false);
    expect(comparison.diagnostic_100q_unlock.reason).toBe("not_gate7_canary_window");
    expect(DIAGNOSTIC_100Q_KPI_PROMOTION.eligible).toBe(false);
    expect(comparison.causal_comparison_status).toBe("eligible");
    expect(comparison.control_misses.S3).toBe(1);
    expect(comparison.treatment_misses.S4).toBe(1);
  });

  it("does not call an unexposed treatment miss still_missing", () => {
    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q-unexposed", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q-unexposed", stage: 5, proof: "budget_drop" })],
      treatmentExposure: [exposure("q-unexposed", "not_exercised", false)]
    });

    expect(comparison.still_missing).toEqual([]);
    expect(comparison.not_exercised).toEqual(["q-unexposed"]);
    expect(comparison.exposure_sli).toMatchObject({
      denominator_kind: "formed_osf_answerable",
      denominator_count: 0,
      exposed_count: 0,
      excluded: { unavailable_or_ineligible_count: 1 }
    });
    expect(comparison.diagnostic_100q_unlock.eligible).toBe(false);
    expect(comparison.causal_comparison_status).toBe("inconclusive");
  });

  it("rejects legacy and tampered persisted comparisons", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-100q-exposure-"));
    const path = join(root, "comparison.json");
    await writeFile(path, JSON.stringify({
      schema_version: 1,
      kind: "diagnostic_100q_f0f2_vs_cached_f3"
    }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /lacks the cached F3 exposure contract/u
    );

    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentExposure: [exposure("q1", "exposed", false)]
    });
    const [receipt] = comparison.treatment_exposure_receipts;
    await writeFile(path, JSON.stringify({
      ...comparison,
      treatment_exposure_receipts: [{ ...receipt, receipt_digest: "0".repeat(64) }]
    }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /treatment exposure receipt/u
    );

    await writeFile(path, JSON.stringify({ ...comparison, schema_version: 4 }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /lacks the cached F3 exposure contract/u
    );
  });

  it("rejects a planted SLI or unlock that does not match receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-100q-sli-policy-"));
    const path = join(root, "comparison.json");
    const comparison = compareF0F2VsCachedF3({
      control: [
        row({ question_id: "q-exposed", stage: 5, proof: "budget_drop" }),
        row({ question_id: "q-unexposed", stage: 5, proof: "budget_drop" })
      ],
      treatment: [
        row({ question_id: "q-exposed", stage: 5, proof: "budget_drop" }),
        row({ question_id: "q-unexposed", stage: 5, proof: "budget_drop" })
      ],
      treatmentExposure: [
        exposure("q-exposed", "exposed", false),
        exposure("q-unexposed", "not_exercised", false)
      ]
    });
    expect(CACHED_F3_EXPOSURE_POLICY.denominator_kind).toBe("formed_osf_answerable");
    expect(comparison.exposure_sli.denominator_kind).toBe(
      CACHED_F3_EXPOSURE_POLICY.denominator_kind
    );
    expect(comparison.exposure_sli.rate).toBe(1);
    expect(comparison.exposure_sli.denominator_count).toBe(1);
    expect(comparison.diagnostic_100q_unlock.eligible).toBe(false);

    await writeFile(path, JSON.stringify({
      ...comparison,
      exposure_sli: { ...comparison.exposure_sli, rate: 0.5, denominator_count: 2 }
    }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /exposure contracts do not match their receipts/u
    );

    await writeFile(path, JSON.stringify({
      ...comparison,
      diagnostic_100q_unlock: {
        ...comparison.diagnostic_100q_unlock,
        eligible: true,
        reason: "gate7_polarity_matrix_passed"
      }
    }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /exposure contracts do not match their receipts/u
    );
  });

  it.each([
    ["deleted classification", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, still_missing: []
    })],
    ["duplicate classification", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, still_missing: ["q1", "q1"]
    })],
    ["wrong classification", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, still_missing: [], membership_improved: ["q1"]
    })],
    ["wrong stage counts", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, control_misses: { ...comparison.control_misses, S4: 99 }
    })],
    ["wrong treatment counts", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, treatment_misses: { ...comparison.treatment_misses, S4: 99 }
    })],
    ["physical calls", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, physical_calls: 1
    })],
    ["500Q closure", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, five_hundred_q_closed: false
    })]
  ] as const)("rejects persisted comparison with %s", async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-100q-classification-"));
    const path = join(root, "comparison.json");
    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentExposure: [exposure("q1", "exposed", false)]
    });
    await writeFile(path, JSON.stringify(mutate(comparison)));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(/diagnostic 100Q/u);
  });

  it("fails closed when a treatment question lacks an exposure receipt", () => {
    expect(() => compareF0F2VsCachedF3({
      control: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentExposure: []
    })).toThrow(/exposure receipts do not match/u);
  });

  it("rejects a recall mechanism split and extra keys on schema 6", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-100q-split-"));
    const path = join(root, "comparison.json");
    const split = buildRecallMechanismSplit({
      questions: [{
        question_id: "q1",
        delivered_hit: { control: false, treatment: true }
      }]
    });
    await writeFile(path, JSON.stringify(split));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /recall mechanism split cannot be reinterpreted as a diagnostic 100Q comparison/u
    );

    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentExposure: [exposure("q1", "exposed", false)]
    });
    await writeFile(path, JSON.stringify(comparison));
    await expect(readDiagnostic100QComparisonArtifact(path)).resolves.toEqual(comparison);

    await writeFile(path, JSON.stringify({
      ...comparison,
      delivered_hit_changed: ["q1"]
    }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /lacks the cached F3 exposure contract/u
    );
  });
});
