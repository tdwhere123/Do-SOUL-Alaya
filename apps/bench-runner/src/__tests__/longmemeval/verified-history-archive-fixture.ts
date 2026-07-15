import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  writeEntry,
  type HistoryEntry,
  type HistoryLayout,
  type KpiPayload,
  type VerifiedLongMemEvalEvidenceContext
} from "@do-soul/alaya-eval";
import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/internal";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import {
  buildQuestionDiagnostic,
  renderDiagnosticsSidecar,
  summarizeProviderStates,
  type LongMemEvalDiagnosticsSidecar,
  type LongMemEvalQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";
import {
  buildLongMemEvalEvidenceManifest,
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput
} from "../../longmemeval/evidence-manifest.js";
import {
  createTestLongMemEvalDatasetAuthority,
  deriveLongMemEvalReleaseEvidenceAuthority
} from "../../longmemeval/fetch.js";
import { createLongMemEvalHistoryLayout } from
  "../../longmemeval/history/evidence-context.js";
import { classifyLongMemEvalDatasetCohort } from
  "../../longmemeval/selection/dataset-cohort.js";

const REPORT = "report\n";
const FULL_DIAGNOSTICS_FILENAME = "longmemeval-diagnostics.json.gz";

export function createVerifiedHistoryAuthority(input: {
  readonly historyRoot: string;
  readonly datasetSha256: string;
  readonly questions: readonly LongMemEvalQuestion[];
}): {
  readonly layout: HistoryLayout;
  readonly releaseEvidenceAuthority: LongMemEvalReleaseEvidenceAuthority;
} {
  const datasetAuthority = createTestLongMemEvalDatasetAuthority({
    datasetSha256: input.datasetSha256,
    assignments: input.questions.map((question) => ({
      question_id: question.question_id,
      dataset_cohort: classifyLongMemEvalDatasetCohort(question)
    }))
  });
  const releaseEvidenceAuthority = deriveLongMemEvalReleaseEvidenceAuthority(
    datasetAuthority,
    { kind: "execution_window", offset: 0, limit: input.questions.length }
  );
  if (releaseEvidenceAuthority === null) {
    throw new Error("verified history fixture could not derive release authority");
  }
  return {
    layout: createLongMemEvalHistoryLayout({
      historyRoot: input.historyRoot,
      authority: releaseEvidenceAuthority
    }),
    releaseEvidenceAuthority
  };
}

export async function writeVerifiedHistoryArchive(input: {
  readonly layout: HistoryLayout;
  readonly slug: string;
  readonly payload: KpiPayload;
}): Promise<{
  readonly entry: HistoryEntry;
  readonly evidenceContext: VerifiedLongMemEvalEvidenceContext;
}> {
  const artifacts = buildFixtureArtifacts(input.payload);
  const manifest = buildFixtureManifest(input.slug, input.payload, artifacts);
  const staged = await stageFullDiagnostics(artifacts);
  try {
    const entry = await writeFixtureEntry(input, artifacts, manifest, staged.path);
    const evidenceContext = await verifyFixtureEntry(input.layout, entry, input.payload);
    return { entry, evidenceContext };
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
}

function buildFixtureManifest(
  slug: string,
  payload: KpiPayload,
  artifacts: readonly LongMemEvalEvidenceArtifactInput[]
) {
  const selection = payload.selection_contract;
  const datasetSha256 = payload.dataset.checksum_sha256;
  if (selection === undefined || datasetSha256 === undefined) {
    throw new Error("verified history fixture requires dataset and selection identity");
  }
  return buildLongMemEvalEvidenceManifest({
    profile: "full_run",
    run: {
      slug,
      bench_name: payload.bench_name,
      split: payload.split,
      run_at: payload.run_at,
      alaya_commit: payload.alaya_commit,
      dataset_sha256: datasetSha256,
      selection_manifest_sha256: null,
      question_id_digest: selection.selected_id_digest,
      selection_contract: selection,
      candidate_pool_complete: true,
      provenance_complete: true
    },
    artifacts
  });
}

async function writeFixtureEntry(
  input: Parameters<typeof writeVerifiedHistoryArchive>[0],
  artifacts: readonly LongMemEvalEvidenceArtifactInput[],
  manifest: ReturnType<typeof buildFixtureManifest>,
  fullDiagnosticsPath: string
): Promise<HistoryEntry> {
  return writeEntry(
    input.layout,
    input.payload.bench_name,
    input.slug,
    input.payload,
    REPORT,
    null,
    {
      sidecars: historySidecars(artifacts, manifest),
      fileSidecars: [{
        filename: FULL_DIAGNOSTICS_FILENAME,
        sourcePath: fullDiagnosticsPath
      }]
    }
  );
}

async function verifyFixtureEntry(
  layout: HistoryLayout,
  entry: HistoryEntry,
  payload: KpiPayload
): Promise<VerifiedLongMemEvalEvidenceContext> {
  if (layout.verifyLongMemEvalEvidence === undefined) {
    throw new Error("verified history fixture requires an evidence verifier");
  }
  const context = await layout.verifyLongMemEvalEvidence({
    entryRoot: path.dirname(entry.kpiPath),
    payload
  });
  if (context === null) {
    throw new Error("verified history fixture did not produce verified evidence");
  }
  return context;
}

function buildFixtureArtifacts(
  payload: KpiPayload
): readonly LongMemEvalEvidenceArtifactInput[] {
  const diagnostics = renderDiagnostics(payload);
  return [
    textArtifact("kpi", "kpi.json", `${JSON.stringify(payload, null, 2)}\n`),
    textArtifact("report", "report.md", REPORT),
    textArtifact("diagnostics", "longmemeval-diagnostics.json", diagnostics),
    {
      role: "full_diagnostics",
      path: FULL_DIAGNOSTICS_FILENAME,
      contents: gzipSync(diagnostics)
    },
    textArtifact(
      "cohort_ledger",
      "longmemeval-cohort-ledger.json",
      renderCohortLedger(payload)
    ),
    textArtifact(
      "comparison",
      "longmemeval-cold-warm-comparison.json",
      `${JSON.stringify({ current_run: payload.run_at })}\n`
    ),
    textArtifact(
      "run_provenance",
      "longmemeval-run-provenance.json",
      `${JSON.stringify(buildRunProvenance(payload), null, 2)}\n`
    )
  ];
}

function renderDiagnostics(payload: KpiPayload): string {
  return renderDiagnosticsSidecar(buildFixtureDiagnostics(payload));
}

function buildFixtureDiagnostics(payload: KpiPayload): LongMemEvalDiagnosticsSidecar {
  const questions = payload.kpi.per_scenario.map(buildVerifiedQuestionDiagnostic);
  if (payload.bench_name !== "public-multiturn" &&
      payload.bench_name !== "public-crossquestion") {
    throw new Error("verified history fixture requires a Tier 1 bench");
  }
  return {
    schema_version: 1,
    bench_name: payload.bench_name,
    split: payload.split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    embedding_provider: payload.embedding_provider,
    embedding_mode: "disabled",
    policy_shape: payload.policy_shape,
    simulate_report: payload.simulate_report,
    seed_extraction_path: payload.kpi.seed_extraction_path,
    provider_state_summary: summarizeProviderStates(questions),
    questions
  };
}

export function buildVerifiedQuestionDiagnostic(
  row: KpiPayload["kpi"]["per_scenario"][number]
): LongMemEvalQuestionDiagnostic {
  const abstention = row.measurement_cohort === "dataset_declared_abstention";
  const goldId = `memory-${row.id}`;
  const candidateId = abstention ? `candidate-${row.id}` : goldId;
  const deliveredResults = row.hit_at_5 && !abstention
    ? [{ object_id: goldId, rank: 1, relevance_score: 1 }]
    : [];
  return buildQuestionDiagnostic({
    questionId: row.id,
    goldMemoryIds: abstention ? [] : [goldId],
    answerSessionIds: abstention ? [] : [`session-${row.id}`],
    deliveredResults,
    hitAt1: row.hit_at_5,
    hitAt5: row.hit_at_5,
    hitAt10: row.hit_at_5,
    isAbstention: abstention,
    degradationReason: null,
    embeddingMode: "disabled",
    recallResult: buildFixtureRecallResult(candidateId, row.hit_at_5)
  });
}

function buildFixtureRecallResult(candidateId: string, delivered: boolean) {
  const rank = delivered ? 1 : 6;
  return {
    diagnostics: {
      provider_state: "provider_not_requested",
      candidates: [{
        object_id: candidateId,
        object_kind: "memory_entry",
        origin_plane: "workspace_local",
        candidate_key: `workspace_local:memory_entry:${candidateId}`,
        created_at: "2026-07-16T00:00:00.000Z",
        facet_overlap: 1,
        pre_budget_rank: rank,
        final_rank: rank,
        selection_order: rank,
        fused_rank: rank,
        fused_score: delivered ? 1 : 0.5,
        per_stream_rank: { lexical_fts: rank },
        fused_rank_contribution_per_stream: { lexical_fts: 1 },
        score_factors: { activation: 1 },
        source_planes: ["lexical"]
      }]
    }
  };
}

function renderCohortLedger(payload: KpiPayload): string {
  const selection = payload.selection_contract!;
  return `${JSON.stringify({
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
}

function buildRunProvenance(payload: KpiPayload) {
  const datasetSha256 = payload.dataset.checksum_sha256!;
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
      executed_dist: { sha256: "c".repeat(64) }
    },
    extraction_cache: {
      dataset_revision: datasetSha256,
      requested_turns: payload.evaluated_count,
      cached_turns: payload.evaluated_count,
      coverage: 1
    },
    execution: { evaluated_count: payload.evaluated_count },
    recall_config: {
      schema_version: 2,
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "d".repeat(64)
    }
  };
}

async function stageFullDiagnostics(
  artifacts: readonly LongMemEvalEvidenceArtifactInput[]
): Promise<{ readonly root: string; readonly path: string }> {
  const artifact = artifacts.find((item) => item.role === "full_diagnostics");
  if (artifact?.contents === undefined || typeof artifact.contents === "string") {
    throw new Error("verified history fixture full diagnostics are missing");
  }
  const root = await mkdtemp(path.join(tmpdir(), "verified-history-artifact-"));
  const artifactPath = path.join(root, FULL_DIAGNOSTICS_FILENAME);
  await writeFile(artifactPath, artifact.contents);
  return { root, path: artifactPath };
}

function historySidecars(
  artifacts: readonly LongMemEvalEvidenceArtifactInput[],
  manifest: ReturnType<typeof buildFixtureManifest>
) {
  const sidecars = artifacts.flatMap((artifact) => {
    if (artifact.role === "kpi" || artifact.role === "report" ||
        artifact.role === "full_diagnostics") return [];
    if (artifact.contents === undefined || typeof artifact.contents !== "string") {
      throw new Error(`verified history fixture ${artifact.role} bytes are invalid`);
    }
    return [{ filename: artifact.path, contents: artifact.contents }];
  });
  return [...sidecars, {
    filename: LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
    contents: renderLongMemEvalEvidenceManifest(manifest)
  }];
}

function textArtifact(
  role: LongMemEvalEvidenceArtifactInput["role"],
  artifactPath: string,
  contents: string
): LongMemEvalEvidenceArtifactInput {
  return { role, path: artifactPath, contents };
}
