import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_CAPTURE_IDENTITY_DIGEST,
  createCanonicalSelectionReceipt
} from "@do-soul/alaya-protocol";
import { evaluateRecallEvalGzipD1Counterfactual } from "../../../bench/diagnostics.js";
import {
  D1_FROZEN_PAIR_AUTHORITY,
  frozenD1PairAuthorityFailure,
  mapD1GoldsToFieldKeys,
  resolveD1GoldAuthority
} from "../../../bench/diagnostics/ranking/d1-pair-authority.js";
import { capturedTruncatedProof } from "../../harness/recall/capture-proof-diagnostics-fixture.js";
import { assembledQuestion } from "./abstention-diagnostic-fixture.js";
import {
  PLANTED_A_ID,
  PLANTED_B_ID,
  PLANTED_C_ID,
  PLANTED_D_ID,
  PLANTED_E_ID,
  PLANTED_GOLD_ID,
  plantedCandidateKey,
  plantedCanonicalQuestion
} from "./planted-canonical-fixture.js";

const FIELD_IDS = [
  PLANTED_A_ID,
  PLANTED_B_ID,
  PLANTED_C_ID,
  PLANTED_D_ID,
  PLANTED_E_ID,
  PLANTED_GOLD_ID
] as const;

describe("d1 counterfactual gzip stream evaluator", () => {
  it("replays planted receipts, skips missing proofs/capture, and does not gate on any@5", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-d1-gzip-"));
    const artifactPath = path.join(root, "recall-eval-diagnostics.json.gz");
    try {
      await writePlantedGzip(artifactPath, [
        withProofs(plantedCanonicalQuestion({
          questionId: "d1-hit",
          fieldObjectIds: [PLANTED_GOLD_ID, PLANTED_A_ID],
          deliveredObjectIds: [PLANTED_GOLD_ID]
        })),
        withProofs(plantedCanonicalQuestion({
          questionId: "d1-miss",
          fieldObjectIds: FIELD_IDS,
          deliveredObjectIds: [
            PLANTED_A_ID,
            PLANTED_B_ID,
            PLANTED_C_ID,
            PLANTED_D_ID,
            PLANTED_E_ID
          ]
        })),
        plantedCanonicalQuestion({
          questionId: "d1-missing-proofs",
          fieldObjectIds: [PLANTED_GOLD_ID],
          deliveredObjectIds: [PLANTED_GOLD_ID]
        }),
        withoutReceipt(withProofs(plantedCanonicalQuestion({
          questionId: "d1-missing-receipt",
          fieldObjectIds: [PLANTED_GOLD_ID],
          deliveredObjectIds: [PLANTED_GOLD_ID]
        }))),
        assembledQuestion({ questionId: "d1-abs", isAbstention: true })
      ]);
      const report = await evaluateRecallEvalGzipD1Counterfactual(artifactPath);
      expect(report.question_count).toBe(5);
      expect(report.answerable_count).toBe(4);
      expect(report.abstention_count).toBe(1);
      expect(report.skipped_missing_proofs).toBe(1);
      expect(report.skipped_missing_capture).toBe(2);
      expect(report.replayed_count).toBe(2);
      expect(report.parse_failure_count).toBe(0);
      expect(report.cycle_failure_count).toBe(0);
      expect(report.production_any_at_5.hits).toBe(3);
      expect(report.production_any_at_5.denominator).toBe(4);
      expect(Number.isFinite(report.d1_any_at_5.hits)).toBe(true);
      expect(report.d1_any_at_5.denominator).toBe(4);
      expect(report.d1_any_at_5.hits).toBeGreaterThanOrEqual(0);
      expect(report.d1_any_at_5.hits).toBeLessThanOrEqual(report.answerable_count);
      expect(report.mean_blocked_pair_share).toBeGreaterThanOrEqual(0);
      expect(report.mean_f1_over_h).toBeGreaterThanOrEqual(0);
      expect(report.mean_max_g_cohort).toBeGreaterThanOrEqual(0);
      expect(report.mean_deterministic_tail_share).toBeGreaterThanOrEqual(0);
      expect(report.total_receipt_backed_dominance_edges).toBeGreaterThanOrEqual(0);
      expect(report.equal_g_same_cohort_shrink).toEqual({
        status: "INCOMPLETE",
        coverage: "partial",
        replayed_questions: 2,
        question_count: 5,
        baseline_cohorts_gt_1: null,
        shrunk_cohorts: null,
        shrink_share: null
      });
      expect(report.gold_occupier_blocking).toMatchObject({
        status: "NOT_REPLAYABLE",
        denominator_basis:
          "field_present_production_miss_gold_x_delivered_ranks_1_to_5",
        reason: "incomplete_question_replay",
        expected_denominator: 1_220,
        observed_denominator: 5
      });
      expect(report.capture_identity.expected).toBe(CANONICAL_CAPTURE_IDENTITY_DIGEST);
      expect(report.capture_identity.matches).toBe(true);
      expect(report.provider_not_requested).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not fabricate blocking zero when a miss lacks capture authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-d1-gzip-"));
    const artifactPath = path.join(root, "recall-eval-diagnostics.json.gz");
    try {
      await writePlantedGzip(artifactPath, [
        withoutReceipt(withProofs(plantedCanonicalQuestion({
          questionId: "d1-missing-comparison-receipt",
          fieldObjectIds: FIELD_IDS,
          deliveredObjectIds: [
            PLANTED_A_ID,
            PLANTED_B_ID,
            PLANTED_C_ID,
            PLANTED_D_ID,
            PLANTED_E_ID
          ]
        })))
      ]);
      const report = await evaluateRecallEvalGzipD1Counterfactual(artifactPath);
      expect(report.gold_occupier_blocking).toMatchObject({
        status: "NOT_REPLAYABLE",
        denominator_basis:
          "field_present_production_miss_gold_x_delivered_ranks_1_to_5",
        reason: "missing_required_field:capture_receipt",
        expected_denominator: 1_220,
        observed_denominator: null
      });
      expect(report.gold_occupier_blocking).not.toHaveProperty("production");
      expect(report.gold_occupier_blocking).not.toHaveProperty("d1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps partial and zero-denominator equal-G evidence unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-d1-gzip-"));
    const artifactPath = path.join(root, "recall-eval-diagnostics.json.gz");
    try {
      await writePlantedGzip(artifactPath, [withProofs(plantedCanonicalQuestion({
        questionId: "d1-no-equal-g-cohort",
        fieldObjectIds: [PLANTED_GOLD_ID],
        deliveredObjectIds: [PLANTED_GOLD_ID]
      }))]);
      const report = await evaluateRecallEvalGzipD1Counterfactual(artifactPath);
      expect(report.equal_g_same_cohort_shrink).toEqual({
        status: "UNAVAILABLE",
        coverage: "complete",
        reason: "no_baseline_equal_g_cohorts_gt_1",
        replayed_questions: 1,
        question_count: 1,
        baseline_cohorts_gt_1: null,
        shrunk_cohorts: null,
        shrink_share: null
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on gold alias drift and unmatched diagnostic gold", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-d1-gzip-"));
    const artifactPath = path.join(root, "recall-eval-diagnostics.json.gz");
    try {
      const planted = withProofs(plantedCanonicalQuestion({
        questionId: "d1-alias-drift",
        fieldObjectIds: FIELD_IDS,
        deliveredObjectIds: FIELD_IDS.slice(0, 5)
      }));
      expect(resolveD1GoldAuthority({
        ...planted,
        gold_object_ids: ["unmatched-gold"]
      })).toEqual({
        status: "NOT_RESOLVED",
        reason: "gold_alias_mismatch:gold_object_ids"
      });
      await writePlantedGzip(artifactPath, [{
        ...planted,
        gold: []
      }]);
      const report = await evaluateRecallEvalGzipD1Counterfactual(artifactPath);
      expect(report.gold_occupier_blocking).toMatchObject({
        status: "NOT_REPLAYABLE",
        reason: "gold_alias_mismatch:question.gold"
      });
      expect(report.skipped_unmapped_gold).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects the same 1,220 count under the wrong sealed pair identity", () => {
    expect(frozenD1PairAuthorityFailure({
      ...D1_FROZEN_PAIR_AUTHORITY,
      replayed_count: D1_FROZEN_PAIR_AUTHORITY.question_count,
      pair_multiset_sha256: "0".repeat(64)
    })).toBe("frozen_pair_multiset_identity_mismatch");
  });

  it("rejects a matching pair count under the wrong question or receipt identity", () => {
    const complete = {
      ...D1_FROZEN_PAIR_AUTHORITY,
      replayed_count: D1_FROZEN_PAIR_AUTHORITY.question_count
    };
    expect(frozenD1PairAuthorityFailure({
      ...complete,
      question_multiset_sha256: "0".repeat(64)
    })).toBe("frozen_question_multiset_identity_mismatch");
    expect(frozenD1PairAuthorityFailure({
      ...complete,
      receipt_multiset_sha256: "0".repeat(64)
    })).toBe("frozen_receipt_multiset_identity_mismatch");
  });

  it("maps Any@5 gold through the same field keys as gold-occupier pairs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-d1-gzip-"));
    const artifactPath = path.join(root, "recall-eval-diagnostics.json.gz");
    try {
      const planted = withFieldPrefix(withProofs(plantedCanonicalQuestion({
        questionId: "d1-field-alias",
        fieldObjectIds: [PLANTED_GOLD_ID],
        deliveredObjectIds: [PLANTED_GOLD_ID]
      })));
      const gold = resolveD1GoldAuthority(planted);
      expect(gold.status).toBe("RESOLVED");
      if (gold.status !== "RESOLVED") return;
      const receipt = planted.capture_receipt;
      expect(receipt?.execution.status).toBe("captured");
      if (receipt?.execution.status !== "captured") return;
      const field = mapD1GoldsToFieldKeys(gold.golds, receipt);
      expect(field).toEqual({
        status: "MAPPED",
        field_keys: ["global:memory_entry:planted-gold"],
        absent: 0
      });
      expect(field.status === "MAPPED" ? field.field_keys[0] : null)
        .not.toBe(plantedCandidateKey(PLANTED_GOLD_ID));
      await writePlantedGzip(artifactPath, [planted]);
      const report = await evaluateRecallEvalGzipD1Counterfactual(artifactPath);
      expect(report.skipped_unmapped_gold).toBe(0);
      expect(report.d1_any_at_5).toEqual({ hits: 1, denominator: 1, rate: 1 });
      expect(report.equal_g_same_cohort_shrink.status).toBe("UNAVAILABLE");
      expect(report.equal_g_same_cohort_shrink.baseline_cohorts_gt_1).toBeNull();
      expect(report.equal_g_same_cohort_shrink.shrink_share).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function withProofs(
  question: ReturnType<typeof plantedCanonicalQuestion>
) {
  return {
    ...question,
    lexical_bound_proofs: [capturedTruncatedProof()]
  };
}

function withoutReceipt(
  question: ReturnType<typeof plantedCanonicalQuestion>
) {
  return {
    ...question,
    capture_receipt: null
  };
}

function withFieldPrefix(
  question: ReturnType<typeof plantedCanonicalQuestion>
) {
  const rewritten = JSON.parse(
    JSON.stringify(question).replaceAll("workspace_local", "global")
  ) as ReturnType<typeof plantedCanonicalQuestion> & {
    readonly candidates?: readonly { readonly capture_receipt_digest?: string }[];
  };
  const receipt = rewritten.capture_receipt;
  if (receipt === null || receipt === undefined) return rewritten;
  const { receipt_digest: _digest, ...body } = receipt;
  const sealed = createCanonicalSelectionReceipt(body, (preimage) =>
    createHash("sha256").update(preimage, "utf8").digest("hex")
  );
  return {
    ...rewritten,
    capture_receipt: sealed,
    candidates: rewritten.candidates?.map((row) => ({
      ...row,
      capture_receipt_digest: sealed.receipt_digest
    }))
  };
}

async function writePlantedGzip(
  artifactPath: string,
  questions: readonly unknown[]
): Promise<void> {
  await writeFile(artifactPath, gzipSync(Buffer.from(JSON.stringify({
    schema_version: 2,
    kind: "recall_eval_diagnostics",
    questions: questions.map((question) => ({
      question_id: (question as { readonly question_id: string }).question_id,
      diagnostics: question
    }))
  }), "utf8")));
}
