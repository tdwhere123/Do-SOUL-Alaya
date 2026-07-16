import { describe, expect, it } from "vitest";
import { createLongMemEvalSelectionContractIdentity } from "@do-soul/alaya-eval";
import type { VerifiedRecallEvalPromotionEntry } from
  "../../longmemeval/promotion/entry-verifier.js";
import { authorizeVerifiedLongMemEvalMatrix } from
  "../../longmemeval/promotion/matrix-validator.js";
import { LongMemEvalMatrixPromotionContractSchema } from
  "../../longmemeval/promotion/contract.js";

describe("LongMemEval promotion capability boundary", () => {
  it("does not authorize raw entry data cast as a verified capability", () => {
    const sourceSelection = selection(100);
    const nextSelection = selection(500);
    const contract = LongMemEvalMatrixPromotionContractSchema.parse({
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
          file_count: 1
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
    const raw = {} as VerifiedRecallEvalPromotionEntry;

    expect(() => authorizeVerifiedLongMemEvalMatrix({
      contract,
      contractSha256: "a".repeat(64),
      sourceSelection,
      nextSelection,
      cells: contract.matrix.entries.map((cell) => ({
        evidenceRoot: cell.evidence_root,
        entry: raw
      }))
    })).toThrow(/not verified/u);
  });
});

function selection(count: number) {
  return createLongMemEvalSelectionContractIdentity({
    datasetSha256: "d".repeat(64),
    assignments: Array.from({ length: count }, (_, index) => ({
      question_id: `question-${index + 1}`,
      dataset_cohort: "answerable" as const
    }))
  });
}

function entry(bi: boolean, cross: boolean, evidenceRoot: string) {
  return {
    treatment: { embedding_supplement: bi, answer_rerank: cross },
    evidence_root: evidenceRoot
  };
}
