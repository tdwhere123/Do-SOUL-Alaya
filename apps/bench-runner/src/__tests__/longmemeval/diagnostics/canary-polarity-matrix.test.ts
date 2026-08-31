import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareF0F2VsCachedF3 } from
  "../../../diagnostics/stage-attribution/diagnostic-100q.js";
import { DIAGNOSTIC_100Q_KPI_PROMOTION } from
  "../../../diagnostics/stage-attribution/exposure/diagnostic-unlock.js";
import { evaluateCanaryPolarityMatrix } from
  "../../../diagnostics/stage-attribution/exposure/canary-polarity-matrix.js";
import {
  CANARY_Q1,
  CANARY_Q2,
  CANARY_Q3
} from "../../../diagnostics/stage-attribution/exposure/canary-ids.js";
import { evaluateSupersededAllQuestionRateGate } from
  "./superseded-rate-gate.js";
import { readDiagnostic100QComparisonArtifact } from
  "../../../diagnostics/stage-attribution/exposure/comparison-artifact.js";
import { exposure } from "./phase/exposure-receipt-fixture.js";
import {
  liveShapedCanaryReceipts,
  liveShapedCanaryRows,
  liveShapedNegativeReceipt,
  liveShapedPositiveReceipt
} from "./phase/canary-fixture.js";

describe("Canary polarity matrix", () => {
  it("is red under the superseded all-question 3/3 rate gate", () => {
    const receipts = liveShapedCanaryReceipts();
    const superseded = evaluateSupersededAllQuestionRateGate(receipts);
    expect(superseded.evaluated_count).toBe(3);
    expect(superseded.exposed_count).toBe(1);
    expect(superseded.actual_rate).toBeCloseTo(1 / 3);
    expect(superseded.passed).toBe(false);
  });

  it("passes Q1 positive and Q2/Q3 negative on the live-shaped canary", () => {
    const receipts = liveShapedCanaryReceipts();
    const matrix = evaluateCanaryPolarityMatrix(receipts);
    expect(matrix.applicable).toBe(true);
    expect(matrix.passed).toBe(true);
    expect(matrix.reason).toBe("canary_polarity_matrix_passed");
    expect(matrix.failure_reasons).toEqual([]);
    expect(matrix.rows.map((row) => [
      row.question_id, row.expected_polarity, row.observed?.exposure, row.verdict
    ])).toEqual([
      [CANARY_Q1, "positive", "exposed", "pass"],
      [CANARY_Q2, "negative", "not_exercised", "pass"],
      [CANARY_Q3, "negative", "not_exercised", "pass"]
    ]);
  });

  it("fail-closes when Q1 is not exposed or a negative control is exposed", () => {
    const receipts = liveShapedCanaryReceipts();
    const q1Hidden = evaluateCanaryPolarityMatrix([
      liveShapedNegativeReceipt(CANARY_Q1),
      receipts[1]!,
      receipts[2]!
    ]);
    expect(q1Hidden.passed).toBe(false);
    expect(q1Hidden.failure_reasons).toContain(`${CANARY_Q1}:exposure`);

    const q2Exposed = evaluateCanaryPolarityMatrix([
      receipts[0]!,
      liveShapedPositiveReceipt(CANARY_Q2),
      receipts[2]!
    ]);
    expect(q2Exposed.passed).toBe(false);
    expect(q2Exposed.failure_reasons).toEqual(expect.arrayContaining([
      `${CANARY_Q2}:compatible_count`,
      `${CANARY_Q2}:composition`,
      `${CANARY_Q2}:activation`,
      `${CANARY_Q2}:exposure`
    ]));

    const q3Exposed = evaluateCanaryPolarityMatrix([
      receipts[0]!,
      receipts[1]!,
      liveShapedPositiveReceipt(CANARY_Q3)
    ]);
    expect(q3Exposed.passed).toBe(false);
    expect(q3Exposed.failure_reasons).toContain(`${CANARY_Q3}:exposure`);
  });

  it("fail-closes on unknown, duplicate, or missing canary questions", () => {
    const receipts = liveShapedCanaryReceipts();
    expect(evaluateCanaryPolarityMatrix([
      receipts[0]!,
      receipts[1]!,
      liveShapedNegativeReceipt("deadbeef")
    ]).failure_reasons).toEqual(expect.arrayContaining([
      `missing_question:${CANARY_Q3}`,
      "unknown_question:deadbeef"
    ]));
    expect(evaluateCanaryPolarityMatrix([
      receipts[0]!,
      receipts[1]!,
      liveShapedNegativeReceipt(CANARY_Q2)
    ]).failure_reasons).toContain("duplicate_question");
  });

  it("does not treat a 1Q or 100Q window as the canary polarity matrix", () => {
    expect(evaluateCanaryPolarityMatrix([
      liveShapedPositiveReceipt(CANARY_Q1)
    ]).reason).toBe("not_canary_window");
    const hundred = [
      ...liveShapedCanaryReceipts(),
      ...Array.from({ length: 97 }, (_, index) =>
        exposure(`extra${String(index).padStart(2, "0")}`, "exposed", false))
    ];
    expect(evaluateCanaryPolarityMatrix(hundred).applicable).toBe(false);
  });

  it("unlocks 100Q diagnostic without promoting KPI", () => {
    const rows = liveShapedCanaryRows();
    const comparison = compareF0F2VsCachedF3({
      ...rows,
      treatmentExposure: liveShapedCanaryReceipts()
    });
    expect(comparison.schema_version).toBe(7);
    expect(comparison.exposure_sli).toMatchObject({
      denominator_kind: "formed_osf_answerable",
      denominator_count: 1,
      exposed_count: 1,
      rate: 1,
      excluded: {
        named_negative_control_count: 2,
        unavailable_or_ineligible_count: 0,
        leaked_negative_control_exposed_count: 0
      }
    });
    expect(comparison.diagnostic_100q_unlock).toMatchObject({
      eligible: true,
      reason: "canary_polarity_matrix_passed",
      binds: { polarity_matrix_passed: true, physical_calls: 0 }
    });
    expect(DIAGNOSTIC_100Q_KPI_PROMOTION).toEqual({
      eligible: false,
      reason: "not_a_kpi_promotion_gate"
    });
    expect(comparison.causal_comparison_status).toBe("eligible");
  });

  it("keeps formed no_match questions in the 100Q SLI denominator", () => {
    const comparison = compareF0F2VsCachedF3({
      control: [
        ...liveShapedCanaryRows().control,
        { ...liveShapedCanaryRows().control[0]!, question_id: "abcd1234" }
      ],
      treatment: [
        ...liveShapedCanaryRows().treatment,
        { ...liveShapedCanaryRows().treatment[1]!, question_id: "abcd1234" }
      ],
      treatmentExposure: [
        ...liveShapedCanaryReceipts(),
        liveShapedNegativeReceipt("abcd1234")
      ]
    });
    expect(comparison.canary_polarity_matrix.applicable).toBe(false);
    expect(comparison.exposure_sli).toMatchObject({
      denominator_kind: "formed_osf_answerable",
      denominator_count: 2,
      exposed_count: 1,
      rate: 0.5,
      excluded: {
        named_negative_control_count: 2,
        unavailable_or_ineligible_count: 0,
        leaked_negative_control_exposed_count: 0
      }
    });
    expect(comparison.diagnostic_100q_unlock.eligible).toBe(false);
    expect(comparison.diagnostic_100q_unlock.reason).toBe("not_canary_window");
  });

  it("does not hide an exposed named negative inside the SLI rate", () => {
    const leaked = compareF0F2VsCachedF3({
      control: liveShapedCanaryRows().control,
      treatment: [
        liveShapedCanaryRows().treatment[0]!,
        {
          ...liveShapedCanaryRows().treatment[0]!,
          question_id: CANARY_Q2
        },
        liveShapedCanaryRows().treatment[2]!
      ],
      treatmentExposure: [
        liveShapedPositiveReceipt(CANARY_Q1),
        liveShapedPositiveReceipt(CANARY_Q2),
        liveShapedNegativeReceipt(CANARY_Q3)
      ]
    });
    expect(leaked.exposure_sli.excluded.leaked_negative_control_exposed_count).toBe(1);
    expect(leaked.exposure_sli.denominator_count).toBe(1);
    expect(leaked.canary_polarity_matrix.passed).toBe(false);
  });

  it("rejects a historical schema-5 rate-gate artifact as current authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "canary-historical-"));
    const path = join(root, "comparison.json");
    const current = compareF0F2VsCachedF3({
      ...liveShapedCanaryRows(),
      treatmentExposure: liveShapedCanaryReceipts()
    });
    await writeFile(path, JSON.stringify({
      ...current,
      schema_version: 5,
      exposed_denominator_gate: evaluateSupersededAllQuestionRateGate(
        current.treatment_exposure_receipts
      ),
      exposure_sli: undefined,
      canary_polarity_matrix: undefined,
      diagnostic_100q_unlock: undefined
    }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /cannot be reinterpreted as current gate authority/u
    );
  });
});
