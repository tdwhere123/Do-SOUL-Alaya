import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLongMemEvalSelectionContractIdentity } from "@do-soul/alaya-eval";
import { LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME } from
  "../../longmemeval/evidence-manifest.js";
import {
  openRecallEvalDiagnosticsArtifact,
  readRecallEvalPromotionManifest
} from "../../longmemeval/promotion/artifact-reader.js";
import {
  MAX_RECALL_EVAL_PROMOTION_DIAGNOSTICS_BYTES,
  MAX_RECALL_EVAL_PROMOTION_FIXED_ARTIFACT_BYTES,
  MAX_RECALL_EVAL_PROMOTION_SMALL_ARTIFACT_BYTES,
  assertRecallEvalPromotionArtifactBudgets
} from "../../longmemeval/promotion/artifact-limits.js";
import {
  RecallEvalPromotionManifestSchema,
  type RecallEvalPromotionManifest
} from "../../longmemeval/promotion/evidence-schema.js";

const roots: string[] = [];
const SHA = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("recall-eval promotion artifact resource limits", () => {
  it("accepts the documented per-artifact and aggregate byte boundary", () => {
    const manifest = promotionManifest([
      artifact(
        "recall_eval_diagnostics",
        MAX_RECALL_EVAL_PROMOTION_DIAGNOSTICS_BYTES
      ),
      artifact("kpi", MAX_RECALL_EVAL_PROMOTION_SMALL_ARTIFACT_BYTES),
      artifact(
        "rank_identity",
        MAX_RECALL_EVAL_PROMOTION_FIXED_ARTIFACT_BYTES -
          MAX_RECALL_EVAL_PROMOTION_SMALL_ARTIFACT_BYTES
      )
    ], 500);

    expect(() => assertRecallEvalPromotionArtifactBudgets(manifest)).not.toThrow();
  });

  it("rejects artifacts whose combined fixed evidence exceeds its budget", () => {
    const manifest = promotionManifest([
      artifact("kpi", MAX_RECALL_EVAL_PROMOTION_SMALL_ARTIFACT_BYTES),
      artifact("rank_identity", MAX_RECALL_EVAL_PROMOTION_SMALL_ARTIFACT_BYTES),
      artifact("run_provenance", 1)
    ]);

    expect(() => assertRecallEvalPromotionArtifactBudgets(manifest))
      .toThrow(/fixed artifacts exceed the aggregate byte budget/u);
  });
});

describe("recall-eval promotion descriptor resource checks", () => {
  it("rejects an oversized diagnostics artifact from the manifest before reading it", async () => {
    const root = await artifactRoot();
    const manifest = promotionManifest([
      artifact(
        "recall_eval_diagnostics",
        MAX_RECALL_EVAL_PROMOTION_DIAGNOSTICS_BYTES + 1
      )
    ]);
    await writeManifest(root, manifest);

    await expect(readRecallEvalPromotionManifest(root))
      .rejects.toThrow(/recall_eval_diagnostics artifact exceeds/u);
  });

  it("binds manifest bytes to the already-open diagnostics descriptor", async () => {
    const root = await artifactRoot();
    const contents = "{}";
    const manifest = promotionManifest([
      artifact("recall_eval_diagnostics", Buffer.byteLength(contents) + 1)
    ]);
    await Promise.all([
      writeManifest(root, manifest),
      writeFile(path.join(root, "diagnostics.json"), contents, "utf8")
    ]);

    await expect(openRecallEvalDiagnosticsArtifact(root, manifest))
      .rejects.toThrow(/artifact byte length mismatch with manifest/u);
  });
});

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "promotion-artifact-limits-"));
  roots.push(root);
  return root;
}

async function writeManifest(
  root: string,
  manifest: RecallEvalPromotionManifest
): Promise<void> {
  await writeFile(
    path.join(root, LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME),
    `${JSON.stringify(manifest)}\n`,
    "utf8"
  );
}

function artifact(
  role: RecallEvalPromotionManifest["artifacts"][number]["role"],
  bytes: number
) {
  return {
    role,
    path: role === "recall_eval_diagnostics" ? "diagnostics.json" : `${role}.json`,
    sha256: SHA,
    bytes
  };
}

function promotionManifest(
  artifacts: RecallEvalPromotionManifest["artifacts"],
  questionCount = 1
): RecallEvalPromotionManifest {
  const selection = createLongMemEvalSelectionContractIdentity({
    datasetSha256: SHA,
    assignments: Array.from({ length: questionCount }, (_, index) => ({
      question_id: `q-${index + 1}`,
      dataset_cohort: "answerable" as const
    }))
  });
  return RecallEvalPromotionManifestSchema.parse({
    schema_version: 1,
    kind: "longmemeval_evidence_bundle",
    profile: "recall_eval",
    run: {
      slug: "resource-boundary",
      bench_name: "public",
      split: "longmemeval-s",
      run_at: "2026-07-17T00:00:00.000Z",
      alaya_commit: "abcdef0",
      dataset_sha256: SHA,
      selection_manifest_sha256: null,
      question_id_digest: selection.selected_id_digest,
      selection_contract: selection,
      candidate_pool_complete: true,
      provenance_complete: true
    },
    evidence_status: "complete",
    artifacts,
    bundle_sha256: SHA
  });
}
