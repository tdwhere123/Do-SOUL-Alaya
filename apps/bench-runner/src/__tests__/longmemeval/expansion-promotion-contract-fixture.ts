import { LongMemEvalMatrixPromotionContractSchema } from
  "../../longmemeval/promotion/contract.js";

export function expansionPromotionContractFixture() {
  return LongMemEvalMatrixPromotionContractSchema.parse({
    schema_version: 1,
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
    matrix: { entries: [
      entry(false, false, "cell-a"),
      entry(true, false, "cell-b"),
      entry(false, true, "cell-c"),
      entry(true, true, "cell-d")
    ] }
  });
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
