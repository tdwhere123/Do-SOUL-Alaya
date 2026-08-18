import { describe, expect, it } from "vitest";
import { LongMemEvalQuestionDiagnosticSchema } from "../../../bench/diagnostics/schema/diagnostics-schema.js";
import {
  RecallAnswerSupportObservationSchema,
  RecallAnswerShapePlanSchema,
  RecallCandidateAnswerSupportSchema,
  RecallDeepHeadTraceSchema
} from "../../../harness/recall/answer-trace-schema.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  stripReplayCandidatePoolsForGateWrite,
  type LongMemEvalDiagnosticsSidecar
} from "../../../bench/diagnostics.js";
import {
  buildLongMemEvalEvidenceManifest,
  verifyLongMemEvalEvidenceManifest
} from "../../../bench/provenance/evidence-manifest.js";
import { collectPairedEnvironment } from "../../../bench/provenance/run.js";
import { completeAnswerFeatures, diagnostic } from "./evidence-contract-test-support.js";

describe("LongMemEval evidence contract manifest", () => {
  it("hash-binds every declared artifact and rejects drift or incomplete replay evidence", () => {
    const artifacts = [
      { role: "kpi" as const, path: "kpi.json", contents: "{\"r_at_5\":0.8}\n" },
      { role: "cohort_ledger" as const, path: "longmemeval-cohort-ledger.json", contents: "{}\n" }
    ];
    const manifest = buildLongMemEvalEvidenceManifest({
      run: {
        slug: "run-1",
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-07-11T00:00:00.000Z",
        alaya_commit: "d7266aa",
        dataset_sha256: "a".repeat(64),
        selection_manifest_sha256: null,
        question_id_digest: "b".repeat(64),
        candidate_pool_complete: false
      },
      artifacts
    });

    expect(verifyLongMemEvalEvidenceManifest(manifest, artifacts)).toEqual({
      valid: true,
      errors: []
    });
    expect(verifyLongMemEvalEvidenceManifest(manifest, [
      artifacts[0]!,
      { ...artifacts[1]!, contents: "drift\n" }
    ])).toMatchObject({ valid: false });
    expect(manifest.evidence_status).toBe("partial");
    expect(() => buildLongMemEvalEvidenceManifest({
      run: { ...manifest.run, dataset_sha256: "unpinned" },
      artifacts
    })).toThrow(/invalid dataset_sha256/u);
  });

  it("hash-binds binary artifact bytes without UTF-8 coercion", () => {
    const compressed = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80]);
    const artifacts = [{
      role: "full_diagnostics" as const,
      path: "longmemeval-diagnostics.json.gz",
      contents: compressed
    }];
    const manifest = buildLongMemEvalEvidenceManifest({
      run: {
        slug: "run-binary",
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-07-11T00:00:00.000Z",
        alaya_commit: "d7266aa",
        dataset_sha256: "a".repeat(64),
        selection_manifest_sha256: null,
        question_id_digest: "b".repeat(64),
        candidate_pool_complete: true
      },
      artifacts
    });

    expect(manifest.artifacts[0]?.bytes).toBe(compressed.byteLength);
    expect(verifyLongMemEvalEvidenceManifest(manifest, artifacts).valid).toBe(true);
    expect(verifyLongMemEvalEvidenceManifest(manifest, [{
      ...artifacts[0]!,
      contents: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xfe, 0x00, 0x80])
    }])).toMatchObject({
      valid: false,
      errors: [expect.stringMatching(/sha256 mismatch/u)]
    });
  });

  it("accepts a precomputed streaming artifact identity", () => {
    const manifest = buildLongMemEvalEvidenceManifest({
      run: {
        slug: "run-stream",
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-07-11T00:00:00.000Z",
        alaya_commit: "d7266aa",
        dataset_sha256: "a".repeat(64),
        selection_manifest_sha256: null,
        question_id_digest: "b".repeat(64),
        candidate_pool_complete: true,
        provenance_complete: true
      },
      artifacts: [{
        role: "full_diagnostics",
        path: "longmemeval-diagnostics.json.gz",
        identity: { sha256: "c".repeat(64), bytes: 42 }
      }]
    });

    expect(manifest.artifacts[0]).toEqual({
      role: "full_diagnostics",
      path: "longmemeval-diagnostics.json.gz",
      sha256: "c".repeat(64),
      bytes: 42
    });
  });

  it.each(["/tmp/escape.json", "../escape.json", "nested/../../escape.json"])(
    "rejects uncontained evidence artifact reference %s",
    (artifactPath) => {
      expect(() => buildLongMemEvalEvidenceManifest({
        run: {
          slug: "run-safe-path",
          bench_name: "public",
          split: "longmemeval-s",
          run_at: "2026-07-11T00:00:00.000Z",
          alaya_commit: "d7266aa",
          dataset_sha256: "a".repeat(64),
          selection_manifest_sha256: null,
          question_id_digest: "b".repeat(64),
          candidate_pool_complete: false
        },
        artifacts: [{ role: "diagnostics", path: artifactPath, contents: "{}" }]
      })).toThrow(/unsafe evidence artifact path/u);
    }
  );

});
