import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import {
  CAPTURED_SCORE_FIDELITY_ASSERT,
  CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
  buildFineAssessmentOrderLedger,
  reconstructFineAssessmentComposition,
  replayFineAssessmentSelectionBoundary,
  type CapturedScoreFidelityMode
} from "@do-soul/alaya-core";
import { publishBytesExclusiveDurable } from
  "../../extraction/fill/manifest/durable-exclusive-publication.js";
import { measureGitState } from
  "../../provenance/contract/frozen-code-contract.js";
import { computeExecutedDistIdentityFresh } from
  "../../provenance/executed-dist-identity.js";
import {
  forEachSelectionBoundaryGzipRecord,
  type SelectionBoundaryArtifactRecord
} from "../selection-boundary-artifact-reader.js";
import {
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES,
  verifyLongMemEvalSelectionBoundaryArtifact
} from
  "../selection-boundary-spool.js";
import { withSelectionBoundaryRecordIdentity } from
  "../selection-boundary-record-identity.js";
import {
  loadSelectionReplayGoldMap,
  type SelectionReplayGoldQuestion
} from "./gold-map.js";
import {
  accumulateRecomputeQuestion,
  buildRecomputeQuestionPayload,
  createRecomputeAccumulator,
  rollupRecomputeSummary,
  type SelectionOrderLedgerRecomputeQuestion,
  type SelectionOrderLedgerRecomputeSummary,
  type StageMembership
} from "./recompute.js";
import { snapshotLedgerSource } from "./source.js";

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
  readonly source_worktree_state_sha256: string;
  readonly executed_dist: ExecutedDistIdentity;
  readonly question_id_digest: string;
  readonly gold_map_sha256?: string;
  readonly question_count: number;
  readonly candidate_count: number;
  readonly coarse_unavailable_questions: number;
  readonly captured_score_fidelity: CapturedScoreFidelityMode;
  readonly recompute?: SelectionOrderLedgerRecomputeSummary;
}>;

export type SelectionOrderLedgerMaterializeInput = Readonly<{
  readonly sourcePath: string;
  readonly expectedSourceSha256: string;
  readonly expectedQuestionCount: number;
  readonly expectedQuestionIdDigest: string;
  readonly outputPath: string;
  readonly checkoutRoot: string;
  readonly capturedScoreFidelity?: CapturedScoreFidelityMode;
  readonly goldMapPath?: string;
  readonly computeExecutedDistIdentity?: () => Promise<unknown>;
}>;

type ExecutedDistIdentity = Readonly<{
  readonly algorithm: "sha256-reachable-path-file-sha256-v1";
  readonly sha256: string;
  readonly file_count: number;
}>;

export async function materializeSelectionOrderLedgerArtifact(
  input: SelectionOrderLedgerMaterializeInput
): Promise<SelectionOrderLedgerArtifactIdentity> {
  const capturedScoreFidelity = resolveLedgerFidelity(input);
  assertSha256(input.expectedSourceSha256);
  assertPopulationAuthority(input);
  const source = await snapshotLedgerSource({
    sourcePath: input.sourcePath,
    expectedSha256: input.expectedSourceSha256,
    outputPath: input.outputPath,
    maxBytes: LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES
  });
  try {
    const [verified, git, executedDist] = await Promise.all([
      verifyLongMemEvalSelectionBoundaryArtifact(source.path),
      measureGitState(input.checkoutRoot),
      resolveExecutedDistIdentity(input.computeExecutedDistIdentity)
    ]);
    assertVerifiedPopulation(input, verified);
    const code = Object.freeze({
      commit: git.commitSha,
      worktreeStateSha256: git.worktreeStateSha256,
      executedDist
    });
    const collected = await collectLedgerRows(
      { ...input, sourcePath: source.path }, source.sha256, code,
      capturedScoreFidelity
    );
    assertCollectedPopulation(input, collected);
    return await publishLedgerArtifact(
      input.outputPath, source.sha256, code, capturedScoreFidelity, collected
    );
  } finally {
    await source.dispose();
  }
}

type LedgerCodeIdentity = Readonly<{
  readonly commit: string;
  readonly worktreeStateSha256: string;
  readonly executedDist: ExecutedDistIdentity;
}>;

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
  code: LedgerCodeIdentity,
  capturedScoreFidelity: CapturedScoreFidelityMode
) {
  const goldByQuestion = capturedScoreFidelity ===
    CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE
    ? await loadSelectionReplayGoldMap(input.goldMapPath!)
    : null;
  const collected = emptyCollectedRows(
    sourceSha256,
    code,
    capturedScoreFidelity,
    goldByQuestion
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
        goldByQuestion?.byQuestion ?? null
      );
    }
  );
  assertGoldPopulation(collected);
  collected.rows.push(JSON.stringify(summaryRow(collected, capturedScoreFidelity)));
  return freezeCollectedRows(collected);
}

type CollectedLedgerRows = {
  rows: string[];
  questionIds: string[];
  questionCount: number;
  candidateCount: number;
  recomputeAcc: ReturnType<typeof createRecomputeAccumulator> | null;
  goldQuestionIds: Set<string> | null;
  goldMapSha256: string | undefined;
};

function emptyCollectedRows(
  sourceSha256: string,
  code: LedgerCodeIdentity,
  capturedScoreFidelity: CapturedScoreFidelityMode,
  goldMap: Awaited<ReturnType<typeof loadSelectionReplayGoldMap>> | null
): CollectedLedgerRows {
  return {
    rows: [JSON.stringify(ledgerManifest(
      sourceSha256,
      code,
      capturedScoreFidelity,
      goldMap?.sha256
    ))],
    questionIds: [],
    questionCount: 0,
    candidateCount: 0,
    recomputeAcc: goldMap === null ? null : createRecomputeAccumulator(),
    goldQuestionIds: goldMap === null ? null : new Set(goldMap.byQuestion.keys()),
    goldMapSha256: goldMap?.sha256
  };
}

function appendQuestionRow(
  collected: CollectedLedgerRows,
  record: SelectionBoundaryArtifactRecord,
  recordIndex: number,
  capturedScoreFidelity: CapturedScoreFidelityMode,
  goldByQuestion: ReadonlyMap<string, SelectionReplayGoldQuestion> | null
): void {
  const verified = verifyRecordLedger(
    record,
    recordIndex,
    capturedScoreFidelity,
    goldByQuestion
  );
  collected.questionIds.push(record.question_id);
  collected.questionCount += 1;
  collected.candidateCount += verified.published.ledger.candidate_count;
  if (
    collected.recomputeAcc !== null &&
    isRecomputeQuestion(verified.published) &&
    verified.capturedStages !== undefined &&
    verified.liveStages !== undefined
  ) {
    accumulateRecomputeQuestion(
      collected.recomputeAcc,
      verified.published,
      verified.capturedStages,
      verified.liveStages
    );
  }
  collected.rows.push(JSON.stringify({
    record_type: "question",
    question_id: record.question_id,
    invocation_index: record.invocation_index,
    ...verified.published
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
    questionIdDigest: computeLongMemEvalQuestionIdDigest(collected.questionIds),
    goldMapSha256: collected.goldMapSha256,
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
  goldByQuestion: ReadonlyMap<string, SelectionReplayGoldQuestion> | null
): VerifiedLedgerRow {
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
      if (goldByQuestion === null) return { published: { ledger } };
      const capturedWalk = replayFineAssessmentSelectionBoundary(record.boundary);
      return {
        published: buildRecomputeQuestionPayload(
          record,
          reconstruction,
          ledger,
          goldByQuestion
        ),
        capturedStages: capturedWalk.orderSequence.transitions,
        liveStages: reconstruction.result.orderSequence.transitions
      };
    }
  );
}

type VerifiedLedgerRow = Readonly<{
  readonly published: { ledger: ReturnType<typeof buildFineAssessmentOrderLedger> } |
    SelectionOrderLedgerRecomputeQuestion;
  readonly capturedStages?: readonly StageMembership[];
  readonly liveStages?: readonly StageMembership[];
}>;

async function publishLedgerArtifact(
  requestedOutputPath: string,
  sourceSha256: string,
  code: LedgerCodeIdentity,
  capturedScoreFidelity: CapturedScoreFidelityMode,
  collected: Awaited<ReturnType<typeof collectLedgerRows>>
): Promise<SelectionOrderLedgerArtifactIdentity> {
  const bytes = gzipSync(`${collected.rows.join("\n")}\n`, { level: 9 });
  const outputPath = await canonicalOutputPath(requestedOutputPath);
  const ownerIdentity = createHash("sha256").update(sourceSha256)
    .update("\0").update(code.commit).digest("hex");
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
    source_commit: code.commit,
    source_worktree_state_sha256: code.worktreeStateSha256,
    executed_dist: code.executedDist,
    question_id_digest: collected.questionIdDigest,
    ...(collected.goldMapSha256 === undefined
      ? {}
      : { gold_map_sha256: collected.goldMapSha256 }),
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
  code: LedgerCodeIdentity,
  capturedScoreFidelity: CapturedScoreFidelityMode,
  goldMapSha256?: string
): Readonly<Record<string, unknown>> {
  const recompute = capturedScoreFidelity ===
    CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE;
  return Object.freeze({
    record_type: "manifest",
    schema_version: recompute ? 2 : 1,
    source_artifact_sha256: sourceSha256,
    source_commit: code.commit,
    source_worktree_state_sha256: code.worktreeStateSha256,
    executed_dist: code.executedDist,
    authoritative_only: true,
    ...(recompute ? {
      captured_score_fidelity: capturedScoreFidelity,
      gold_map_sha256: goldMapSha256
    } : {})
  });
}

function assertGoldPopulation(collected: CollectedLedgerRows): void {
  if (collected.goldQuestionIds === null) return;
  const sourceIds = new Set(collected.questionIds);
  if (sourceIds.size !== collected.goldQuestionIds.size ||
      [...sourceIds].some((id) => !collected.goldQuestionIds?.has(id))) {
    throw new Error("selection replay gold map question set mismatch");
  }
}

function assertPopulationAuthority(input: SelectionOrderLedgerMaterializeInput): void {
  if (!Number.isSafeInteger(input.expectedQuestionCount) ||
      input.expectedQuestionCount <= 0) {
    throw new Error("selection order ledger expected question count must be positive");
  }
  assertSha256(input.expectedQuestionIdDigest);
}

function assertVerifiedPopulation(
  input: SelectionOrderLedgerMaterializeInput,
  verified: { readonly questionCount: number; readonly questionIdDigest: string }
): void {
  if (verified.questionCount !== input.expectedQuestionCount ||
      verified.questionIdDigest !== input.expectedQuestionIdDigest) {
    throw new Error("selection order ledger source population identity mismatch");
  }
}

function assertCollectedPopulation(
  input: SelectionOrderLedgerMaterializeInput,
  collected: { readonly questionCount: number; readonly questionIdDigest: string }
): void {
  if (collected.questionCount !== input.expectedQuestionCount ||
      collected.questionIdDigest !== input.expectedQuestionIdDigest) {
    throw new Error("selection order ledger collected population identity mismatch");
  }
}

async function resolveExecutedDistIdentity(
  compute: () => Promise<unknown> = computeExecutedDistIdentityFresh
): Promise<ExecutedDistIdentity> {
  const value = await compute();
  if (typeof value !== "object" || value === null) {
    throw new Error("selection order ledger executed dist identity is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.algorithm !== "sha256-reachable-path-file-sha256-v1" ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      !Number.isSafeInteger(record.file_count) || Number(record.file_count) <= 0) {
    throw new Error("selection order ledger executed dist identity is invalid");
  }
  return Object.freeze({
    algorithm: record.algorithm,
    sha256: record.sha256,
    file_count: Number(record.file_count)
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
