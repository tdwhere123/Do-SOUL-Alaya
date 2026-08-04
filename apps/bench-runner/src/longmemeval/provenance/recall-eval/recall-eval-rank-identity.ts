import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotQuestionIdDigest } from "../../snapshot/materialize.js";
import type { EvidenceSearchProjectionRebuildReport } from
  "../../snapshot/recall-eval/evidence-search-projection-rebuild.js";
import type { WarmDerivedSnapshotBinding } from
  "../../snapshot/recall-eval/warm-derived/warm-derived-snapshot-receipt.js";
import type { RecallEvalSelectionBoundaryBinding } from
  "../../lifecycle/recall-eval/recall-eval-selection-replay.js";

export const RECALL_EVAL_RANK_IDENTITY_FILENAME =
  "recall-eval-rank-identity.json";

export interface RecallEvalRankIdentityInput {
  readonly questionId: string;
  readonly deliveredObjects: readonly Readonly<{
    object_id: string;
    object_kind: string;
  }>[];
}

export interface RecallEvalRankIdentityBinding {
  readonly expectedQuestionCount: number;
  readonly expectedQuestionIdDigest: string | null;
  readonly requireFullSnapshotMatch: boolean;
  readonly derivedEvidenceProjectionRebuild?: EvidenceSearchProjectionRebuildReport;
  readonly warmDerivedSnapshot?: WarmDerivedSnapshotBinding;
  readonly selectionBoundary?: RecallEvalSelectionBoundaryBinding;
}

export function renderRecallEvalRankIdentity(
  collected: readonly RecallEvalRankIdentityInput[],
  binding: RecallEvalRankIdentityBinding
): string {
  if (collected.length === 0) {
    throw new Error("recall-eval rank identity refuses an empty replay");
  }
  const questionIdDigest = snapshotQuestionIdDigest(collected);
  const fullSnapshotMatch =
    collected.length === binding.expectedQuestionCount &&
    binding.expectedQuestionIdDigest !== null &&
    questionIdDigest === binding.expectedQuestionIdDigest;
  if (binding.requireFullSnapshotMatch && !fullSnapshotMatch) {
    throw new Error("recall-eval rank identity does not match the frozen snapshot binding");
  }
  assertSelectionBoundaryBinding(binding.selectionBoundary);
  const questions = collected.map((result) => ({
    question_id: result.questionId,
    delivered_objects: result.deliveredObjects.map((object) => ({ ...object }))
  }));
  return `${JSON.stringify({
    schema_version: 2,
    snapshot_binding: {
      expected_question_count: binding.expectedQuestionCount,
      expected_question_id_digest: binding.expectedQuestionIdDigest,
      ...(binding.derivedEvidenceProjectionRebuild === undefined
        ? {}
        : {
            derived_evidence_projection_rebuild:
              binding.derivedEvidenceProjectionRebuild
          }),
      ...(binding.warmDerivedSnapshot === undefined
        ? {}
        : { warm_derived_snapshot: binding.warmDerivedSnapshot })
    },
    replay: {
      question_count: collected.length,
      question_id_digest: questionIdDigest,
      full_snapshot_match: fullSnapshotMatch,
      ...(binding.selectionBoundary === undefined
        ? {}
        : { selection_boundary: binding.selectionBoundary })
    },
    questions
  }, null, 2)}\n`;
}

function assertSelectionBoundaryBinding(
  binding: RecallEvalSelectionBoundaryBinding | undefined
): void {
  if (binding === undefined) return;
  if (binding.filename !== "selection-boundaries.ndjson.gz" ||
      !/^[a-f0-9]{64}$/u.test(binding.sha256) ||
      !Number.isSafeInteger(binding.bytes) || binding.bytes <= 0 ||
      !Number.isSafeInteger(binding.record_count) || binding.record_count <= 0) {
    throw new Error("recall-eval selection boundary binding is invalid");
  }
}

export async function writeRecallEvalRankIdentity(
  archiveRoot: string,
  collected: readonly RecallEvalRankIdentityInput[],
  binding: RecallEvalRankIdentityBinding
): Promise<void> {
  await writeFile(
    join(archiveRoot, RECALL_EVAL_RANK_IDENTITY_FILENAME),
    renderRecallEvalRankIdentity(collected, binding),
    "utf8"
  );
}
