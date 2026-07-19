import { LongMemEvalMatrixPromotionContractSchema } from
  "../../../longmemeval/promotion/schema/contract.js";

export function expansionPromotionContractFixture() {
  return LongMemEvalMatrixPromotionContractSchema.parse({
    schema_version: 2,
    kind: "longmemeval_matrix_promotion_contract",
    policy_version: "longmemeval-product-default-v1",
    code: {
      commit_sha: "abcdef0" + "1".repeat(33),
      commit_sha7: "abcdef0",
      worktree_state_sha256: "b".repeat(64),
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "8".repeat(64),
        file_count: 42
      }
    },
    dataset: { variant: "longmemeval_s" },
    selection: {
      policy_version: "dataset-prefix-full-snapshot-v1",
      source_prefix_count: 100,
      target_full_count: 500
    },
    snapshot: {
      db_path: "snapshot/source-100.db",
      manifest_sha256: "f".repeat(64)
    },
    execution_order: ["A", "B", "C", "D", "B2"],
    matrix: { entries: [
      entry(false, false, "cell-a"),
      entry(true, false, "cell-b"),
      entry(false, true, "cell-c"),
      entry(true, true, "cell-d")
    ] },
    product_default_replication: {
      cell: "B2",
      treatment: { embedding_supplement: true, answer_rerank: false },
      evidence_root: "cell-b2"
    },
    absolute_quality_policy: expansionAbsoluteQualityPolicyFixture(),
    material_effect_policy: expansionMaterialEffectPolicyFixture()
  });
}

export function expansionAbsoluteQualityPolicyFixture() {
  return {
    product_cell: "B" as const,
    replication_cell: "B2" as const,
    metric: "r_at_5" as const,
    cohort: "answerable" as const,
    expected_denominator: 94 as const,
    minimum_hits: 85 as const
  };
}

export function expansionMaterialEffectPolicyFixture() {
  return {
    control_cell: "A" as const,
    product_cell: "B" as const,
    answerable_count: 94 as const,
    declared_abstention_count: 6 as const,
    directional_metrics: [
      "r_at_1", "r_at_5", "r_at_10", "full_gold_at_5"
    ] as const,
    token_non_regression_metric: "token_saved_ratio_vs_full_prompt" as const,
    minimum_net_r_at_5_wins: 5 as const,
    mcnemar: {
      method: "exact_two_sided" as const,
      p_value_max_exclusive: 0.05 as const
    }
  };
}

export function expansionMaterialEffectFixture() {
  return {
    status: "passed" as const,
    directional: {
      r_at_1: metricDelta(0.8, 0.81),
      r_at_5: metricDelta(80 / 94, 89 / 94),
      r_at_10: metricDelta(0.9, 0.91),
      full_gold_at_5: metricDelta(0.7, 0.71)
    },
    safeguards: {
      token_saved_ratio_vs_full_prompt: metricDelta(0.9, 0.9),
      measurement_attribution: "eligible_in_both" as const
    },
    paired_r_at_5: {
      answerable_count: 94 as const,
      control_hits: 80,
      product_hits: 89,
      gained: 9,
      lost: 0,
      net: 9,
      mcnemar: { method: "exact_two_sided" as const, p_value: 0.00390625 }
    }
  };
}

export function expansionHardGateFixture() {
  return {
    id: "longmemeval_s_100_embedding_on_r_at_5",
    label: "R@5",
    current: 0.91,
    target: 0.9,
    direction: "min" as const,
    unit: "ratio" as const,
    passed: true as const,
    missing: false as const
  };
}

function entry(bi: boolean, cross: boolean, evidenceRoot: string) {
  return {
    treatment: { embedding_supplement: bi, answer_rerank: cross },
    evidence_root: evidenceRoot
  };
}

function metricDelta(control: number, product: number) {
  return { control, product, delta: product - control };
}
