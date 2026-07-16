import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  createLongMemEvalReleaseEvidenceAuthority,
  loadLongMemEvalReleaseEvidenceFromAuthority,
  type LongMemEvalEvidenceArtifact,
  type LongMemEvalFullDiagnosticsValidator,
  type VerifiedLongMemEvalEvidenceContext
} from "../../gates/longmemeval-verified-evidence.js";
import type { KpiPayload } from "../../schema/kpi-schema.js";
import type { LongMemEvalSelectionAssignment } from
  "../../schema/longmemeval-selection-contract.js";

export async function verifiedEvidenceForPayload(
  payload: KpiPayload,
  authorityAssignments?: readonly LongMemEvalSelectionAssignment[],
  validateFullDiagnostics: LongMemEvalFullDiagnosticsValidator =
    validateFixtureFullDiagnostics
): Promise<VerifiedLongMemEvalEvidenceContext> {
  const selection = payload.selection_contract;
  const datasetSha256 = payload.dataset.checksum_sha256;
  if (selection === undefined || datasetSha256 === undefined) {
    throw new Error("verified evidence fixture requires selection and dataset identity");
  }
  const artifacts = buildArtifacts(payload);
  const manifest = buildFixtureManifest(payload, artifacts, selection, datasetSha256);
  const root = await mkdtemp(path.join(tmpdir(), "verified-evidence-fixture-"));
  try {
    const entryRoot = path.join(root, "entry");
    await writeEvidenceFixture({ entryRoot, manifest, artifacts });
    return await loadLongMemEvalReleaseEvidenceFromAuthority({
      entryRoot,
      payload,
      authority: createLongMemEvalReleaseEvidenceAuthority({
        datasetSha256,
        assignments: fixtureAuthorityAssignments(payload, authorityAssignments)
      }),
      validateFullDiagnostics
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function buildFixtureManifest(
  payload: KpiPayload,
  artifacts: readonly LongMemEvalEvidenceArtifact[],
  selection: NonNullable<KpiPayload["selection_contract"]>,
  datasetSha256: string
) {
  const unsigned = {
    schema_version: 1 as const,
    kind: "longmemeval_evidence_bundle" as const,
    profile: "full_run" as const,
    run: {
      slug: "2026-05-14T100000Z-abc1234",
      bench_name: payload.bench_name,
      split: payload.split,
      run_at: payload.run_at,
      alaya_commit: payload.alaya_commit,
      dataset_sha256: datasetSha256,
      selection_manifest_sha256: null,
      question_id_digest: selection.selected_id_digest,
      selection_contract: selection,
      candidate_pool_complete: true as const,
      provenance_complete: true as const
    },
    evidence_status: "complete" as const,
    artifacts: artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      ...artifactIdentity(requireArtifactContents(artifact))
    }))
  };
  const manifest = {
    ...unsigned,
    bundle_sha256: sha256(JSON.stringify(unsigned))
  };
  return manifest;
}

function fixtureAuthorityAssignments(
  payload: KpiPayload,
  override?: readonly LongMemEvalSelectionAssignment[]
): readonly LongMemEvalSelectionAssignment[] {
  return override ?? payload.kpi.per_scenario.map((row) => ({
    question_id: row.id,
    dataset_cohort: row.measurement_cohort === "dataset_declared_abstention"
      ? "abstention" as const
      : "answerable" as const
  }));
}

function validateFixtureFullDiagnostics(
  input: Parameters<LongMemEvalFullDiagnosticsValidator>[0]
): void {
  if (input.contents.byteLength !== 0) {
    throw new Error("verified evidence fixture expects empty diagnostics bytes");
  }
}

async function writeEvidenceFixture(input: {
  readonly entryRoot: string;
  readonly manifest: unknown;
  readonly artifacts: readonly LongMemEvalEvidenceArtifact[];
}): Promise<void> {
  await mkdir(input.entryRoot, { recursive: true });
  await Promise.all(input.artifacts.map((artifact) => {
    if (artifact.contents === undefined) throw new Error("fixture artifact bytes missing");
    return writeFile(path.join(input.entryRoot, artifact.path), artifact.contents);
  }));
  await writeFile(
    path.join(input.entryRoot, LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME),
    `${JSON.stringify(input.manifest, null, 2)}\n`
  );
}

function requireArtifactContents(
  artifact: LongMemEvalEvidenceArtifact
): string | Uint8Array {
  if (artifact.contents === undefined) throw new Error("fixture artifact bytes missing");
  return artifact.contents;
}

function buildArtifacts(payload: KpiPayload): LongMemEvalEvidenceArtifact[] {
  const selection = payload.selection_contract!;
  const cohort = `${JSON.stringify({
    schema_version: 1,
    question_count: payload.evaluated_count,
    question_id_digest: selection.selected_id_digest,
    selection_contract: selection,
    rows: payload.kpi.per_scenario.map((row) => ({
      question_id: row.id,
      dataset_cohort: row.measurement_cohort === "dataset_declared_abstention"
        ? "abstention"
        : "answerable"
    }))
  }, null, 2)}\n`;
  return [
    artifact("kpi", "kpi.json", `${JSON.stringify(payload, null, 2)}\n`),
    artifact("report", "report.md", "report\n"),
    artifact("diagnostics", "longmemeval-diagnostics.json", "{}\n"),
    artifact("full_diagnostics", "longmemeval-diagnostics.json.gz", new Uint8Array()),
    artifact("cohort_ledger", "longmemeval-cohort-ledger.json", cohort),
    artifact("comparison", "longmemeval-cold-warm-comparison.json", "{}\n"),
    artifact("run_provenance", "longmemeval-run-provenance.json",
      `${JSON.stringify(runProvenance(payload), null, 2)}\n`)
  ];
}

function runProvenance(payload: KpiPayload) {
  const datasetSha256 = payload.dataset.checksum_sha256!;
  const cacheKey = "e".repeat(64);
  const rawSha = "f".repeat(64);
  return {
    schema_version: 1,
    dataset_sha256: datasetSha256,
    selection: payload.selection_contract,
    code: {
      commit_sha7: payload.alaya_commit,
      commit_sha: `${payload.alaya_commit}${"0".repeat(40 - payload.alaya_commit.length)}`,
      gate_sha256: "a".repeat(64),
      gate_contract_path: "/fixture/gate.json",
      worktree_state_sha256: "b".repeat(64),
      worktree_clean: true,
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "c".repeat(64),
        file_count: 1
      }
    },
    extraction_cache: {
      schema_version: 3,
      manifest_sha256: "1".repeat(64),
      extraction_model: "fixture-model",
      model_family: "fixture-family",
      request_profile: "provider-default-v1",
      provider_url: "redacted",
      system_prompt_sha256: "2".repeat(64),
      cache_key_algo: "sha256-content-v1",
      dataset: "longmemeval-s",
      dataset_revision: datasetSha256,
      requested_turns: 1,
      cached_turns: 1,
      coverage: 1,
      storage: "git-tracked",
      built_at: "2026-07-17T00:00:00.000Z",
      builder: "fixture",
      fill_status: "complete",
      window_offset: 0,
      window_limit: payload.evaluated_count,
      expected_turns: 1,
      expected_key_set_sha256: sha256(cacheKey),
      content_closure_sha256: sha256(JSON.stringify([
        cacheKey, "fixture-model", "provider-default-v1", rawSha, 1, 1
      ])),
      content_closure_index: { [cacheKey]: [rawSha, 1, 1] }
    },
    runtime: {
      node_version: "v24.0.0",
      platform: "linux",
      arch: "x64",
      embedding_mode: "disabled",
      embedding_provider_kind: "openai",
      embedding_provider_label: "none",
      onnx_threads: null,
      embedding_supplement: { enabled: false },
      answer_rerank: { enabled: false },
      paired_env: {}
    },
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: payload.evaluated_count,
      evaluated_count: payload.evaluated_count
    },
    recall_config: {
      conf_slice_compatibility: false,
      schema_version: 2,
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "d".repeat(64)
    },
    seed_capabilities: { facet_tags_enabled: false },
    question_manifest: null
  };
}

function artifact(
  role: string,
  path: string,
  contents: string | Uint8Array
): LongMemEvalEvidenceArtifact {
  return { role, path, contents };
}

function artifactIdentity(contents: string | Uint8Array) {
  return {
    sha256: sha256(contents),
    bytes: typeof contents === "string"
      ? Buffer.byteLength(contents, "utf8")
      : contents.byteLength
  };
}

function sha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}
