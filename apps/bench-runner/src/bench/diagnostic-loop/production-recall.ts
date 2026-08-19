import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { runRecallEval } from "../lifecycle/recall-eval/recall-eval-impl.js";
import { RECALL_EVAL_DIAGNOSTICS_GZIP_FILENAME } from
  "../provenance/recall-eval/recall-eval-diagnostics.js";
import { writeStageAttributionTables } from "../diagnostics/stage-attribution/write-tables.js";
import { compareF0F2VsCachedF3 } from "../diagnostics/stage-attribution/diagnostic-100q.js";
import { DiagnosticLoopFailure } from "./failures.js";
import { sha256Utf8 } from "./identity.js";
import { sharedSubstrateIdentities } from "./run.js";
import type {
  DiagnosticLoopPhaseContext,
  DiagnosticLoopPhaseResult
} from "./types.js";
import { resolveSnapshotIdentity } from "./authority/identity.js";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import { sha256File } from "../snapshot/integrity.js";

export async function runProductionRecallPhase(
  context: DiagnosticLoopPhaseContext,
  arm: "control" | "treatment"
): Promise<DiagnosticLoopPhaseResult> {
  const substrate = sharedSubstrateIdentities(context);
  const snapshotCheckpoint = context.checkpoints.get("snapshot");
  const snapshot = snapshotCheckpoint?.artifact_paths.snapshot;
  const historyRoot = context.request.historyRoot;
  const phase = arm === "control" ? "control_recall" : "treatment_recall";
  if (substrate.cache_identity.length === 0 || substrate.snapshot_identity.length === 0) {
    throw fail(phase, "formation", `${arm} recall requires extraction and snapshot checkpoints`);
  }
  if (snapshot === undefined || historyRoot === undefined) {
    throw fail(phase, "infrastructure", `${arm} recall requires --snapshot and --history-root`);
  }
  if (arm === "treatment" && context.request.treatmentFactorCachePath === undefined) {
    throw fail(phase, "formation", "treatment recall requires --query-semantic-factor-cache");
  }
  const snapshotIdentity = await resolveSnapshotIdentity(snapshot, context.request.variant);
  if (snapshotCheckpoint?.content_identity !== snapshotIdentity.identity_digest) {
    throw fail(phase, "infrastructure", `${arm} recall snapshot checkpoint drifted`);
  }
  const evaluationSlice = expectedEvaluationSlice(
    context, snapshotIdentity.question_ids, phase
  );
  const result = await runRecallEval({
    snapshotDbPath: snapshot,
    variant: context.request.variant,
    historyRoot,
    snapshotConsumeAuthority: "diagnostic",
    ...(context.request.limit === undefined ? {} : { limit: context.request.limit }),
    ...(context.request.offset === undefined ? {} : { offset: context.request.offset }),
    ...(context.request.dataDir === undefined ? {} : { dataDir: context.request.dataDir }),
    ...(arm === "treatment"
      ? { querySemanticFactorCachePath: context.request.treatmentFactorCachePath }
      : {})
  });
  if (result.completion.status !== "complete") {
    throw fail(phase, "infrastructure", `${arm} recall completed incompletely`);
  }
  const actualSlice = result.payload.recall_eval_attribution?.evaluation_slice;
  if (JSON.stringify(actualSlice) !== JSON.stringify(evaluationSlice)) {
    throw fail(phase, "infrastructure", `${arm} recall evaluation slice mismatch`);
  }
  const artifacts = {
    snapshot,
    kpi: result.kpiPath,
    report: result.reportPath,
    diagnostics: join(dirname(result.kpiPath), RECALL_EVAL_DIAGNOSTICS_GZIP_FILENAME)
  };
  const artifactSha256 = await hashRecallArtifacts(artifacts);
  return {
    contentIdentity: sha256Utf8(`${arm}:${result.slug}:${substrate.snapshot_identity}`),
    physicalCalls: 0,
    artifactPaths: artifacts,
    details: {
      ...substrate,
      evaluation_slice: evaluationSlice,
      artifact_sha256: artifactSha256
    }
  };
}

async function hashRecallArtifacts(
  artifacts: Readonly<Record<"kpi" | "report" | "diagnostics", string>> & {
    readonly snapshot: string;
  }
) {
  const entries = await Promise.all((["kpi", "report", "diagnostics"] as const)
    .map(async (key) => [key, await sha256File(artifacts[key])] as const));
  return Object.fromEntries(entries);
}

function expectedEvaluationSlice(
  context: DiagnosticLoopPhaseContext,
  questionIds: readonly string[],
  phase: "control_recall" | "treatment_recall"
) {
  const offset = context.request.offset ?? 0;
  const limit = context.request.limit ?? questionIds.length - offset;
  if (offset > questionIds.length || limit < 1 || offset + limit > questionIds.length) {
    throw fail(
      phase, "infrastructure",
      "requested evaluation window is not contained in the snapshot"
    );
  }
  const selected = questionIds.slice(offset, offset + limit).map((questionId) => ({
    questionId
  }));
  return {
    offset,
    limit: context.request.limit ?? null,
    evaluated_count: selected.length,
    question_id_digest: computeLongMemEvalQuestionIdDigest(
      selected.map((question) => question.questionId)
    )
  };
}

export async function runProductionMissLedgerPhase(
  context: DiagnosticLoopPhaseContext
): Promise<DiagnosticLoopPhaseResult> {
  const control = context.checkpoints.get("control_recall");
  const treatment = context.checkpoints.get("treatment_recall");
  const outDir = join(context.workRoot, "miss-ledger");
  const controlDiag = control?.artifact_paths.diagnostics;
  const treatmentDiag = treatment?.artifact_paths.diagnostics;
  if (controlDiag === undefined || treatmentDiag === undefined) {
    throw fail(
      "miss_ledger",
      "infrastructure",
      "miss ledger requires control and treatment diagnostics artifacts"
    );
  }
  const tables = await writeStageAttributionTables({
    outDir,
    cells: [
      { cell: "A", diagnosticsPath: controlDiag },
      { cell: "B", diagnosticsPath: treatmentDiag }
    ]
  });
  const comparison = compareF0F2VsCachedF3({
    control: tables.A.questions,
    treatment: tables.B.questions
  });
  const missLedgerPath = join(outDir, "diagnostic-100q.json");
  await writeFile(
    missLedgerPath,
    `${JSON.stringify(comparison, null, 2)}\n`,
    "utf8"
  );
  return {
    contentIdentity: sha256Utf8(JSON.stringify({
      control: control?.content_identity ?? null,
      treatment: treatment?.content_identity ?? null
    })),
    physicalCalls: 0,
    artifactPaths: { missLedger: missLedgerPath },
    details: {
      ...sharedSubstrateIdentities(context),
      artifact_sha256: await sha256File(missLedgerPath)
    }
  };
}

function fail(
  phase: "control_recall" | "treatment_recall" | "miss_ledger",
  classification: "formation" | "infrastructure",
  message: string
): DiagnosticLoopFailure {
  return new DiagnosticLoopFailure({ phase, classification, message, resumeCommand: "" });
}
