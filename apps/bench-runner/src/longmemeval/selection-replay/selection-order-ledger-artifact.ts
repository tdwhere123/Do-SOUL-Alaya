import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  CAPTURED_SCORE_FIDELITY_ASSERT,
  CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
  buildFineAssessmentOrderLedger,
  reconstructFineAssessmentComposition,
  type CapturedScoreFidelityMode
} from "@do-soul/alaya-core";
import { publishBytesExclusiveDurable } from
  "../extraction/fill/manifest/durable-exclusive-publication.js";
import { measureGitState } from
  "../provenance/contract/frozen-code-contract.js";
import { sha256File } from "../snapshot/integrity.js";
import {
  forEachSelectionBoundaryGzipRecord,
  type SelectionBoundaryArtifactRecord
} from "./selection-boundary-artifact-reader.js";
import {
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES,
  verifyLongMemEvalSelectionBoundaryArtifact
} from
  "./selection-boundary-spool.js";
import { withSelectionBoundaryRecordIdentity } from
  "./selection-boundary-record-identity.js";
import { loadSelectionReplayGoldMap } from "./selection-boundary-gold-map.js";
import {
  accumulateRecomputeQuestion,
  buildRecomputeQuestionPayload,
  createRecomputeAccumulator,
  rollupRecomputeSummary,
  type SelectionOrderLedgerRecomputeQuestion,
  type SelectionOrderLedgerRecomputeSummary
} from "./selection-order-ledger-recompute.js";

const ARTIFACT_ERRORS = Object.freeze({
  utf8Invalid: (context: string) =>
    `selection order ledger source UTF-8 is invalid (${context})`,
  jsonInvalid: (context: string) =>
    `selection order ledger source JSON is invalid (${context})`,
  gzipExceeded: (maxBytes: number) =>
    `selection order ledger source exceeds ${maxBytes} compressed bytes`
});

export type SelectionOrderLedgerArtifactIdentity = Readonly<{
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly source_sha256: string;
  readonly source_commit: string;
  readonly question_count: number;
  readonly candidate_count: number;
  readonly coarse_unavailable_questions: number;
  readonly captured_score_fidelity: CapturedScoreFidelityMode;
  readonly recompute?: SelectionOrderLedgerRecomputeSummary;
}>;

export type SelectionOrderLedgerMaterializeInput = Readonly<{
  readonly sourcePath: string;
  readonly expectedSourceSha256: string;
  readonly outputPath: string;
  readonly checkoutRoot: string;
  readonly capturedScoreFidelity?: CapturedScoreFidelityMode;
  readonly goldMapPath?: string;
}>;

export async function materializeSelectionOrderLedgerArtifact(
  input: SelectionOrderLedgerMaterializeInput
): Promise<SelectionOrderLedgerArtifactIdentity> {
  const capturedScoreFidelity = resolveLedgerFidelity(input);
  assertSha256(input.expectedSourceSha256);
  const [sourceSha256, git] = await Promise.all([
    sha256File(input.sourcePath),
    measureGitState(input.checkoutRoot)
  ]);
  if (sourceSha256 !== input.expectedSourceSha256) {
    throw new Error("selection order ledger source SHA-256 mismatch");
  }
  await verifyLongMemEvalSelectionBoundaryArtifact(input.sourcePath);
  const collected = await collectLedgerRows(
    input,
    sourceSha256,
    git.commitSha,
    capturedScoreFidelity
  );
  if (await sha256File(input.sourcePath) !== sourceSha256) {
    throw new Error("selection order ledger source changed while reading");
  }
  return publishLedgerArtifact(
    input.outputPath,
    sourceSha256,
    git.commitSha,
    capturedScoreFidelity,
    collected
  );
}

export function resolveLedgerFidelity(
  input: Readonly<{
    readonly capturedScoreFidelity?: CapturedScoreFidelityMode;
    readonly goldMapPath?: string;
  }>
): CapturedScoreFidelityMode {
  const mode = input.capturedScoreFidelity ?? CAPTURED_SCORE_FIDELITY_ASSERT;
  if (
    mode !== CAPTURED_SCORE_FIDELITY_ASSERT &&
    mode !== CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE
  ) {
    throw new Error(`captured score fidelity mode is not supported: ${String(mode)}`);
  }
  if (mode === CAPTURED_SCORE_FIDELITY_ASSERT && input.goldMapPath !== undefined) {
    throw new Error(
      "gold map applies only to captured-score-fidelity recompute-live"
    );
  }
  if (mode === CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE &&
      (input.goldMapPath === undefined || input.goldMapPath.length === 0)) {
    throw new Error("recompute_live requires a gold map");
  }
  return mode;
}

async function collectLedgerRows(
  input: SelectionOrderLedgerMaterializeInput,
  sourceSha256: string,
  sourceCommit: string,
  capturedScoreFidelity: CapturedScoreFidelityMode
) {
  const goldByQuestion = capturedScoreFidelity ===
    CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE
    ? await loadSelectionReplayGoldMap(input.goldMapPath!)
    : null;
  const collected = emptyCollectedRows(
    sourceSha256,
    sourceCommit,
    capturedScoreFidelity,
    goldByQuestion !== null
  );
  await forEachSelectionBoundaryGzipRecord(
    input.sourcePath,
    LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES,
    ARTIFACT_ERRORS,
    (record, recordIndex) => {
      if (!record.authoritative) return;
      appendQuestionRow(
        collected,
        record,
        recordIndex,
        capturedScoreFidelity,
        goldByQuestion
      );
    }
  );
  collected.rows.push(JSON.stringify(summaryRow(collected, capturedScoreFidelity)));
  return freezeCollectedRows(collected);
}

type CollectedLedgerRows = {
  rows: string[];
  questionCount: number;
  candidateCount: number;
  recomputeAcc: ReturnType<typeof createRecomputeAccumulator> | null;
};

function emptyCollectedRows(
  sourceSha256: string,
  sourceCommit: string,
  capturedScoreFidelity: CapturedScoreFidelityMode,
  recompute: boolean
): CollectedLedgerRows {
  return {
    rows: [JSON.stringify(ledgerManifest(
      sourceSha256,
      sourceCommit,
      capturedScoreFidelity
    ))],
    questionCount: 0,
    candidateCount: 0,
    recomputeAcc: recompute ? createRecomputeAccumulator() : null
  };
}

function appendQuestionRow(
  collected: CollectedLedgerRows,
  record: SelectionBoundaryArtifactRecord,
  recordIndex: number,
  capturedScoreFidelity: CapturedScoreFidelityMode,
  goldByQuestion: Awaited<ReturnType<typeof loadSelectionReplayGoldMap>> | null
): void {
  const question = verifyRecordLedger(
    record,
    recordIndex,
    capturedScoreFidelity,
    goldByQuestion
  );
  collected.questionCount += 1;
  collected.candidateCount += question.ledger.candidate_count;
  if (collected.recomputeAcc !== null && isRecomputeQuestion(question)) {
    accumulateRecomputeQuestion(collected.recomputeAcc, question);
  }
  collected.rows.push(JSON.stringify({
    record_type: "question",
    question_id: record.question_id,
    invocation_index: record.invocation_index,
    ...question
  }));
}

function summaryRow(
  collected: CollectedLedgerRows,
  capturedScoreFidelity: CapturedScoreFidelityMode
): Readonly<Record<string, unknown>> {
  const recompute = collected.recomputeAcc === null
    ? {}
    : {
        captured_score_fidelity: capturedScoreFidelity,
        ...rollupRecomputeSummary(collected.recomputeAcc)
      };
  return Object.freeze({
    record_type: "summary",
    question_count: collected.questionCount,
    candidate_count: collected.candidateCount,
    coarse_unavailable_questions: 0,
    ...recompute
  });
}

function freezeCollectedRows(collected: CollectedLedgerRows) {
  return Object.freeze({
    rows: Object.freeze(collected.rows),
    questionCount: collected.questionCount,
    candidateCount: collected.candidateCount,
    recompute: collected.recomputeAcc === null
      ? undefined
      : rollupRecomputeSummary(collected.recomputeAcc)
  });
}

function verifyRecordLedger(
  record: SelectionBoundaryArtifactRecord,
  recordIndex: number,
  capturedScoreFidelity: CapturedScoreFidelityMode,
  goldByQuestion: Awaited<ReturnType<typeof loadSelectionReplayGoldMap>> | null
): { ledger: ReturnType<typeof buildFineAssessmentOrderLedger> } |
  SelectionOrderLedgerRecomputeQuestion {
  return withSelectionBoundaryRecordIdentity(
    "selection order ledger record verification failed",
    record,
    recordIndex,
    () => {
      const reconstruction = reconstructFineAssessmentComposition(
        record.boundary,
        { capturedScoreFidelity }
      );
      const ledger = buildFineAssessmentOrderLedger(
        reconstruction.result.orderSequence,
        reconstruction.result.candidates.length
      );
      if (ledger.coarse_identity === "unavailable") {
        throw new Error(
          "selection order ledger coarse identity is unavailable"
        );
      }
      if (goldByQuestion === null) return { ledger };
      return buildRecomputeQuestionPayload(
        record,
        reconstruction,
        ledger,
        goldByQuestion
      );
    }
  );
}

async function publishLedgerArtifact(
  requestedOutputPath: string,
  sourceSha256: string,
  sourceCommit: string,
  capturedScoreFidelity: CapturedScoreFidelityMode,
  collected: Awaited<ReturnType<typeof collectLedgerRows>>
): Promise<SelectionOrderLedgerArtifactIdentity> {
  const bytes = gzipSync(`${collected.rows.join("\n")}\n`, { level: 9 });
  const outputPath = await canonicalOutputPath(requestedOutputPath);
  const ownerIdentity = createHash("sha256").update(sourceSha256)
    .update("\0").update(sourceCommit).digest("hex");
  publishBytesExclusiveDurable({
    destination: outputPath,
    bytes,
    ownerIdentity,
    temporaryDirectory: dirname(outputPath)
  });
  return Object.freeze({
    path: outputPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    source_sha256: sourceSha256,
    source_commit: sourceCommit,
    question_count: collected.questionCount,
    candidate_count: collected.candidateCount,
    coarse_unavailable_questions: 0,
    captured_score_fidelity: capturedScoreFidelity,
    ...(collected.recompute === undefined
      ? {}
      : { recompute: collected.recompute })
  });
}

function ledgerManifest(
  sourceSha256: string,
  sourceCommit: string,
  capturedScoreFidelity: CapturedScoreFidelityMode
): Readonly<Record<string, unknown>> {
  const recompute = capturedScoreFidelity ===
    CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE;
  return Object.freeze({
    record_type: "manifest",
    schema_version: recompute ? 2 : 1,
    source_artifact_sha256: sourceSha256,
    source_commit: sourceCommit,
    authoritative_only: true,
    ...(recompute ? { captured_score_fidelity: capturedScoreFidelity } : {})
  });
}

function isRecomputeQuestion(
  question: { ledger: ReturnType<typeof buildFineAssessmentOrderLedger> } |
    SelectionOrderLedgerRecomputeQuestion
): question is SelectionOrderLedgerRecomputeQuestion {
  return "gold" in question;
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("selection order ledger source SHA-256 is invalid");
  }
}

async function canonicalOutputPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const directory = await realpath(dirname(absolute));
  return resolve(directory, basename(absolute));
}
