import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CANONICAL_CAPTURE_IDENTITY_DIGEST } from "@do-soul/alaya-protocol";
import { evaluateRecallEvalGzipD1Counterfactual } from "../../../bench/diagnostics.js";
import { capturedTruncatedProof } from "../../harness/recall/capture-proof-diagnostics-fixture.js";
import { assembledQuestion } from "./abstention-diagnostic-fixture.js";
import {
  PLANTED_A_ID,
  PLANTED_B_ID,
  PLANTED_C_ID,
  PLANTED_D_ID,
  PLANTED_E_ID,
  PLANTED_GOLD_ID,
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
      expect(report.capture_identity.expected).toBe(CANONICAL_CAPTURE_IDENTITY_DIGEST);
      expect(report.capture_identity.matches).toBe(true);
      expect(report.provider_not_requested).toBeGreaterThan(0);
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
