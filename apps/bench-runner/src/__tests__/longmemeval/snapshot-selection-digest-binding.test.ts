import { readFileSync } from "node:fs";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import { describe, expect, it } from "vitest";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  assertSnapshotConsumerBinding,
  snapshotQuestionIdDigest,
  type LongMemEvalSnapshotManifest,
  type LongMemEvalSnapshotQuestion
} from "../../longmemeval/snapshot.js";
import { computeLegacySnapshotQuestionIdDigestV1 } from
  "../../longmemeval/snapshot/legacy-question-id-digest.js";

interface DigestVector {
  readonly name: string;
  readonly question_ids: readonly string[];
  readonly canonical_nul_v1: string;
  readonly legacy_snapshot_length_prefix_v1: string;
}

interface InvalidCanonicalPreimage {
  readonly name: string;
  readonly question_id_sequences: readonly (readonly string[])[];
}

const DIGEST_VECTORS = JSON.parse(readFileSync(new URL(
  "../../../scripts/longmemeval-replay/question-id-digest-vectors.json",
  import.meta.url
), "utf8")) as {
  readonly invalid_canonical_preimages: readonly InvalidCanonicalPreimage[];
  readonly vectors: readonly DigestVector[];
};
const UNICODE_VECTOR = DIGEST_VECTORS.vectors.find(
  (vector) => vector.name === "ordered_unicode_pair"
);
if (UNICODE_VECTOR === undefined) throw new Error("missing ordered_unicode_pair digest vector");

describe("snapshot selection digest binding", () => {
  it.each(DIGEST_VECTORS.vectors)(
    "uses the canonical selection digest for $name IDs",
    (vector) => {
      expect(snapshotQuestionIdDigest(
        vector.question_ids.map((questionId) => ({ questionId }))
      )).toBe(vector.canonical_nul_v1);
      expect(computeLongMemEvalQuestionIdDigest(vector.question_ids))
        .toBe(vector.canonical_nul_v1);
      expect(computeLegacySnapshotQuestionIdDigestV1(vector.question_ids))
        .toBe(vector.legacy_snapshot_length_prefix_v1);
    }
  );

  it.each(DIGEST_VECTORS.invalid_canonical_preimages)(
    "rejects the shared invalid canonical preimage $name",
    (preimage) => {
      expect(preimage.question_id_sequences).toHaveLength(2);
      const [left, right] = preimage.question_id_sequences;
      expect(left!.join("\0")).toBe(right!.join("\0"));
      for (const questionIds of preimage.question_id_sequences) {
        expect(() => computeLongMemEvalQuestionIdDigest(questionIds)).toThrow(/NUL-free/u);
        expect(() => snapshotQuestionIdDigest(
          questionIds.map((questionId) => ({ questionId }))
        )).toThrow(/NUL-free/u);
      }
    }
  );

  it("fails closed on a current manifest carrying the historical digest semantics", () => {
    const questions = UNICODE_VECTOR.question_ids.map(snapshotQuestion);
    const manifest = snapshotManifest(
      UNICODE_VECTOR.legacy_snapshot_length_prefix_v1,
      UNICODE_VECTOR.question_ids.length
    );

    expect(() => assertSnapshotConsumerBinding({
      snapshotDbPath: "/tmp/snapshot.db",
      manifest,
      sidecar: {
        schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
        variant: manifest.variant,
        questions
      },
      variant: manifest.variant
    })).toThrow(/question digest binding mismatch/u);
  });

  it("never admits legacy digest semantics for an eligible manifest", () => {
    const questions = UNICODE_VECTOR.question_ids.map(snapshotQuestion);
    const manifest = {
      ...snapshotManifest(
        UNICODE_VECTOR.legacy_snapshot_length_prefix_v1,
        questions.length
      ),
      schema_version: 1,
      attribution: { status: "legacy_unattributed" as const, gate_eligible: true }
    };

    expect(() => assertSnapshotConsumerBinding({
      snapshotDbPath: "/tmp/snapshot.db",
      manifest,
      sidecar: {
        schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
        variant: manifest.variant,
        questions
      },
      variant: manifest.variant
    })).toThrow(/requires permanent ineligibility/u);
  });
});

function snapshotQuestion(questionId: string): LongMemEvalSnapshotQuestion {
  return {
    questionId,
    question: questionId,
    questionDate: "2026-01-01T00:00:00.000Z",
    answerSessionIds: [],
    sidecar: [],
    workspaceId: `workspace-${questionId}`,
    runId: `run-${questionId}`
  };
}

function snapshotManifest(
  questionIdDigest: string,
  questionCount: number
): LongMemEvalSnapshotManifest {
  return {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: "longmemeval_s",
    question_count: questionCount,
    recall_pipeline_version: "fixture-pipeline",
    schema_migration_version: 1,
    bench_runner_version: "fixture",
    alaya_commit: "fixture",
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-01-01T00:00:00.000Z",
    extraction_provenance: null,
    question_id_digest: questionIdDigest
  };
}
