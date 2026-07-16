import type { ContainedArtifactFile } from
  "../../cli/merge/contained-artifact-path.js";
import type { RecallEvalPromotionManifest } from "./evidence-schema.js";

const MIB = 1024 * 1024;

export const MAX_RECALL_EVAL_PROMOTION_QUESTIONS = 500;
export const MAX_RECALL_EVAL_PROMOTION_QUESTION_BYTES = 4 * MIB;
export const MAX_RECALL_EVAL_PROMOTION_DIAGNOSTICS_METADATA_BYTES = 16 * MIB;
export const MAX_RECALL_EVAL_PROMOTION_DIAGNOSTICS_BYTES =
  MAX_RECALL_EVAL_PROMOTION_DIAGNOSTICS_METADATA_BYTES +
  MAX_RECALL_EVAL_PROMOTION_QUESTIONS *
    MAX_RECALL_EVAL_PROMOTION_QUESTION_BYTES;
export const MAX_RECALL_EVAL_PROMOTION_SMALL_ARTIFACT_BYTES = 32 * MIB;
export const MAX_RECALL_EVAL_PROMOTION_FIXED_ARTIFACT_BYTES = 64 * MIB;
export const MAX_RECALL_EVAL_PROMOTION_TOTAL_ARTIFACT_BYTES =
  MAX_RECALL_EVAL_PROMOTION_DIAGNOSTICS_BYTES +
  MAX_RECALL_EVAL_PROMOTION_FIXED_ARTIFACT_BYTES;
export const MAX_RECALL_EVAL_PROMOTION_MANIFEST_BYTES = 4 * MIB;

type PromotionArtifact = RecallEvalPromotionManifest["artifacts"][number];

// The diagnostics budget scales with the product's 500-question ceiling.
// Four MiB is the promotion resource allowance for one streamed question,
// not a schema maximum; the metadata allowance matches the generic diagnostics
// reader. Other evidence shares a fixed 64 MiB envelope.
// Valid UTF-8 never has more decoded code units than source bytes, so the same
// per-question value is also a conservative JSON reader character limit.
export function assertRecallEvalPromotionArtifactBudgets(
  manifest: RecallEvalPromotionManifest
): void {
  const seen = new Set<PromotionArtifact["role"]>();
  let fixedBytes = 0;
  let totalBytes = 0;
  for (const artifact of manifest.artifacts) {
    if (seen.has(artifact.role)) {
      throw new Error(`duplicate recall-eval ${artifact.role} artifact`);
    }
    seen.add(artifact.role);
    assertArtifactByteLimit(artifact);
    totalBytes = addArtifactBytes(totalBytes, artifact.bytes);
    if (artifact.role !== "recall_eval_diagnostics") {
      fixedBytes = addArtifactBytes(fixedBytes, artifact.bytes);
    }
  }
  if (fixedBytes > MAX_RECALL_EVAL_PROMOTION_FIXED_ARTIFACT_BYTES) {
    throw new Error("recall-eval fixed artifacts exceed the aggregate byte budget");
  }
  if (totalBytes > MAX_RECALL_EVAL_PROMOTION_TOTAL_ARTIFACT_BYTES) {
    throw new Error("recall-eval artifacts exceed the aggregate byte budget");
  }
}

export function assertRecallEvalOpenedArtifactSize(
  artifact: PromotionArtifact,
  file: ContainedArtifactFile
): void {
  if (file.bytes !== artifact.bytes) {
    throw new Error(
      `artifact byte length mismatch with manifest: ${artifact.path}`
    );
  }
}

export function recallEvalPromotionArtifactByteLimit(
  role: PromotionArtifact["role"]
): number {
  return role === "recall_eval_diagnostics"
    ? MAX_RECALL_EVAL_PROMOTION_DIAGNOSTICS_BYTES
    : MAX_RECALL_EVAL_PROMOTION_SMALL_ARTIFACT_BYTES;
}

function assertArtifactByteLimit(artifact: PromotionArtifact): void {
  const limit = recallEvalPromotionArtifactByteLimit(artifact.role);
  if (artifact.bytes > limit) {
    throw new Error(
      `recall-eval ${artifact.role} artifact exceeds ${limit} bytes`
    );
  }
}

function addArtifactBytes(total: number, bytes: number): number {
  const next = total + bytes;
  if (!Number.isSafeInteger(next)) {
    throw new Error("recall-eval artifact byte total is not a safe integer");
  }
  return next;
}
