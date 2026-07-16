import { describe, expect, it } from "vitest";
import {
  LongMemEvalMatrixPromotionContractSchema,
  matrixCellForTreatment,
  parseLongMemEvalMatrixPromotionContract,
  productDefaultTreatment
} from "../../longmemeval/promotion/contract.js";

describe("LongMemEval matrix promotion contract", () => {
  it("accepts only the exact treatment Cartesian product and derives B from policy", () => {
    const raw = contractFixture();
    const parsed = parseLongMemEvalMatrixPromotionContract(JSON.stringify(raw));

    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(parsed.contract.matrix.entries.map((entry) =>
      matrixCellForTreatment(entry.treatment))).toEqual(["A", "B", "C", "D"]);
    expect(productDefaultTreatment(parsed.contract.policy_version)).toEqual({
      embedding_supplement: true,
      answer_rerank: false
    });
  });

  it("rejects duplicate treatment cells even when four entries are present", () => {
    const raw = contractFixture();
    raw.matrix.entries[3]!.treatment = { ...raw.matrix.entries[0]!.treatment };

    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw))
      .toThrow(/Cartesian product/u);
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

  it("rejects a snapshot substrate outside the contract root", () => {
    const raw = contractFixture();
    raw.snapshot.db_path = "../snapshot.db";

    expect(() => LongMemEvalMatrixPromotionContractSchema.parse(raw))
      .toThrow(/snapshot DB must be a contained relative path/u);
  });
});

function contractFixture() {
  return {
    schema_version: 1 as const,
    kind: "longmemeval_matrix_promotion_contract" as const,
    policy_version: "longmemeval-product-default-v1" as const,
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
      manifest_sha256: "f".repeat(64)
    },
    matrix: {
      entries: [
        entry(false, false, "cell-a"),
        entry(true, false, "cell-b"),
        entry(false, true, "cell-c"),
        entry(true, true, "cell-d")
      ]
    }
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
