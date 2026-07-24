import { describe, expect, it } from "vitest";
import {
  LongMemEvalMatrixPromotionContractSchema,
  matrixCellForTreatment,
  parseLongMemEvalMatrixPromotionContract,
  productDefaultTreatment
} from "../../../longmemeval/promotion/schema/contract.js";

describe("LongMemEval matrix promotion contract", () => {
  it("accepts only the A/B treatment pair and derives B from policy", () => {
    const raw = contractFixture();
    const parsed = parseLongMemEvalMatrixPromotionContract(JSON.stringify(raw));

    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(parsed.contract.matrix.entries.map((entry) =>
      matrixCellForTreatment(entry.treatment))).toEqual(["A", "B"]);
    expect(productDefaultTreatment(parsed.contract.policy_version)).toEqual({
      embedding_supplement: true,
      answer_rerank: false
    });
    expect(parsed.contract.execution_order).toEqual(["A", "B"]);
    expect(parsed.contract.absolute_quality_policy).toEqual({
      control_cell: "A",
      product_cell: "B",
      metric: "r_at_5",
      cohort: "answerable",
      expected_denominator: 94,
      control_minimum_hits: 76,
      product_minimum_hits: 90
    });
  });

  it("rejects duplicate treatment cells even when two entries are present", () => {
    const raw = contractFixture();
    raw.matrix.entries[1]!.treatment = { ...raw.matrix.entries[0]!.treatment };

    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw))
      .toThrow(/A\/B treatment pair/u);
  });

  it.each([
    ["question IDs", { question_ids: ["q-1"] }],
    ["digest", { selected_id_digest: "a".repeat(64) }],
    ["threshold", { r_at_5_min: 0.9 }]
  ])("rejects benchmark-fitting %s in the selection contract", (_label, extra) => {
    const raw = contractFixture();
    Object.assign(raw.selection, extra);

    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw)).toThrow();
  });

  it.each([1, 99, 101, 499])(
    "rejects a %i-question source that is not the qualification slice",
    (sourcePrefixCount) => {
      const raw = contractFixture();
      raw.selection.source_prefix_count = sourcePrefixCount;

      expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw)).toThrow();
    }
  );

  it("rejects evidence roots that escape the contract root", () => {
    const raw = contractFixture();
    raw.matrix.entries[0]!.evidence_root = "../forged";

    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw))
      .toThrow(/contained relative path/u);
  });

  it("rejects duplicate matrix evidence roots", () => {
    const raw = contractFixture();
    raw.matrix.entries[1]!.evidence_root = raw.matrix.entries[0]!.evidence_root;
    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw))
      .toThrow(/evidence roots must be unique/u);
  });

  it("rejects result-fitted material-effect policy or run order", () => {
    const fitted = contractFixture();
    fitted.material_effect_policy.paired_r_at_5_diagnostic.mcnemar_method = "asymptotic";
    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(fitted)).toThrow();

    const reordered = {
      ...contractFixture(),
      execution_order: ["B", "A"] as const
    };
    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(reordered)).toThrow();
  });

  it("rejects a weakened absolute product-quality policy", () => {
    const raw = contractFixture();
    raw.absolute_quality_policy.product_minimum_hits = 89;

    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw)).toThrow();
  });

  it("rejects a legacy v2 contract even when it carries v3 policy fields", () => {
    expect(() => LongMemEvalMatrixPromotionContractSchema.parse({
      ...contractFixture(),
      schema_version: 2
    })).toThrow();
  });

  it("rejects a snapshot substrate outside the contract root", () => {
    const raw = contractFixture();
    raw.snapshot.db_path = "../snapshot.db";

    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw))
      .toThrow(/snapshot DB must be a contained relative path/u);
  });
});

function contractFixture() {
  return {
    schema_version: 3 as const,
    kind: "longmemeval_matrix_promotion_contract" as const,
    policy_version: "longmemeval-product-default-v2" as const,
    code: {
      commit_sha: "abcdef0" + "1".repeat(33),
      commit_sha7: "abcdef0",
      worktree_state_sha256: "b".repeat(64),
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1" as const,
        sha256: "8".repeat(64),
        file_count: 1
      }
    },
    dataset: { variant: "longmemeval_s" as const },
    selection: {
      policy_version: "dataset-prefix-full-snapshot-v1" as const,
      source_prefix_count: 100,
      target_full_count: 500
    },
    snapshot: {
      db_path: "snapshot/source-100.db",
      manifest_sha256: "f".repeat(64),
      producer_code: {
        commit_sha: "1234567" + "2".repeat(33),
        commit_sha7: "1234567",
        worktree_state_sha256: "3".repeat(64),
        executed_dist: {
          algorithm: "sha256-reachable-path-file-sha256-v1" as const,
          sha256: "4".repeat(64),
          file_count: 2
        }
      }
    },
    execution_order: ["A", "B"] as ["A", "B"],
    matrix: {
      entries: [
        entry(false, false, "cell-a"),
        entry(true, false, "cell-b")
      ]
    },
    absolute_quality_policy: absoluteQualityPolicy(),
    material_effect_policy: {
      control_cell: "A" as const,
      product_cell: "B" as const,
      answerable_count: 94,
      declared_abstention_count: 6,
      directional_metrics: ["r_at_1", "r_at_5", "r_at_10", "full_gold_at_5"] as const,
      token_diagnostic_metric: "token_saved_ratio_vs_full_prompt" as const,
      paired_r_at_5_diagnostic: {
        mcnemar_method: "exact_two_sided" as const
      }
    }
  };
}

function absoluteQualityPolicy() {
  return {
    control_cell: "A" as const,
    product_cell: "B" as const,
    metric: "r_at_5" as const,
    cohort: "answerable" as const,
    expected_denominator: 94,
    control_minimum_hits: 76,
    product_minimum_hits: 90
  };
}

function entry(
  embeddingSupplement: boolean,
  answerRerank: boolean,
  evidenceRoot: string
) {
  return {
    treatment: {
      embedding_supplement: embeddingSupplement,
      answer_rerank: answerRerank
    },
    evidence_root: evidenceRoot
  };
}
