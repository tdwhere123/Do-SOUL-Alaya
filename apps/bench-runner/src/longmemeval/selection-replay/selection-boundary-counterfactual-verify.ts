import { readFile } from "node:fs/promises";
import {
  counterfactualDeliveredCandidateKeys,
  INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR,
  NONLEXICAL_UNIT_INTERVAL_COMPOSITION_OPERATOR,
  reconstructFineAssessmentComposition,
  reconstructIndependentEmbeddingEvidenceComposition,
  reconstructNonlexicalUnitIntervalComposition,
  SELECTION_BOUNDARY_FIDELITY_MISMATCH,
  auxiliaryEstimatesToMap,
  type CounterfactualCompositionOptions,
  type FineAssessmentSelectionBoundaryCase,
  type SelectionCompositionReconstruction
} from "@do-soul/alaya-core";
import {
  forEachSelectionBoundaryGzipRecord,
  type SelectionBoundaryArtifactRecord
} from "./selection-boundary-artifact-reader.js";
import {
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES
} from "./selection-boundary-spool.js";
import {
  companionRecordKey,
  loadCfTokenCompanionArtifact,
  type CfTokenCompanionLoad
} from "./selection-boundary-cf-token-companion.js";
import {
  accumulateCounterfactualRecord,
  anyGoldInHead,
  createCounterfactualCellAccumulator,
  rollupCounterfactualCellMetricsBase,
  type CounterfactualRecordEvaluation,
  type SelectionCounterfactualCellMetricsBase
} from "./selection-boundary-counterfactual-metrics.js";

const COUNTERFACTUAL_ARTIFACT_ERRORS = Object.freeze({
  utf8Invalid: (context: string) =>
    `selection counterfactual record UTF-8 is invalid (${context})`,
  jsonInvalid: (context: string) =>
    `selection counterfactual record JSON is invalid (${context})`,
  gzipExceeded: (maxBytes: number) =>
    `selection counterfactual gzip exceeds the ${maxBytes} byte size limit`
});

export type SelectionCounterfactualOperatorId =
  | typeof INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR
  | typeof NONLEXICAL_UNIT_INTERVAL_COMPOSITION_OPERATOR;

export type SelectionCounterfactualCellMetrics =
  SelectionCounterfactualCellMetricsBase & Readonly<{
    readonly operator: SelectionCounterfactualOperatorId;
  }>;

export type CounterfactualQuestionTransition = Readonly<{
  readonly questionId: string;
  readonly baselineHitAt5: boolean;
  readonly counterfactualHitAt5: boolean | null;
  readonly unseenTokenFailure: boolean;
}>;

type GoldQuestion = Readonly<{
  readonly answerable: boolean;
  readonly goldObjectIds: readonly string[];
}>;

type CounterfactualReconstruct = (
  boundary: FineAssessmentSelectionBoundaryCase,
  options?: CounterfactualCompositionOptions
) => SelectionCompositionReconstruction;

type EvaluateOptions = {
  readonly maxArtifactBytes?: number;
  readonly authoritativeOnly?: boolean;
  readonly cfTokenCompanion?: CfTokenCompanionLoad;
  readonly onRecord?: (evaluation: CounterfactualRecordEvaluation) => void;
};

export async function evaluateSelectionCounterfactual(
  artifactPath: string,
  goldMapPath: string,
  operator: SelectionCounterfactualOperatorId,
  reconstruct: CounterfactualReconstruct,
  options: EvaluateOptions = {}
): Promise<SelectionCounterfactualCellMetrics> {
  const goldByQuestion = await loadGoldByQuestion(goldMapPath);
  const maxArtifactBytes = options.maxArtifactBytes ??
    LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES;
  const authoritativeOnly = options.authoritativeOnly ?? true;
  const acc = createCounterfactualCellAccumulator();
  let hardError: Error | null = null;

  const { recordCount } = await forEachSelectionBoundaryGzipRecord(
    artifactPath,
    maxArtifactBytes,
    COUNTERFACTUAL_ARTIFACT_ERRORS,
    (record) => {
      if (hardError !== null) return;
      if (authoritativeOnly && !record.authoritative) return;
      try {
        const evaluation = evaluateCounterfactualRecord(
          record,
          goldByQuestion,
          options.cfTokenCompanion,
          reconstruct
        );
        accumulateCounterfactualRecord(acc, evaluation);
        options.onRecord?.(evaluation);
      } catch (error) {
        hardError = error instanceof Error ? error : new Error(String(error));
      }
    }
  );

  if (hardError !== null) throw hardError;
  return Object.freeze({
    operator,
    ...rollupCounterfactualCellMetricsBase(acc, recordCount, authoritativeOnly)
  });
}

export async function evaluateSelectionCounterfactualWithCompanion(
  artifactPath: string,
  goldMapPath: string,
  companionGzipPath: string,
  companionManifestPath: string,
  operator: SelectionCounterfactualOperatorId,
  reconstruct: CounterfactualReconstruct,
  options: Omit<EvaluateOptions, "cfTokenCompanion"> = {}
): Promise<SelectionCounterfactualCellMetrics> {
  const cfTokenCompanion = await loadCfTokenCompanionArtifact({
    gzipPath: companionGzipPath,
    manifestPath: companionManifestPath
  });
  return evaluateSelectionCounterfactual(
    artifactPath,
    goldMapPath,
    operator,
    reconstruct,
    { ...options, cfTokenCompanion }
  );
}

export async function evaluateIndependentEmbeddingEvidenceCounterfactual(
  artifactPath: string,
  goldMapPath: string,
  options: EvaluateOptions = {}
): Promise<SelectionCounterfactualCellMetrics> {
  return evaluateSelectionCounterfactual(
    artifactPath,
    goldMapPath,
    INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR,
    reconstructIndependentEmbeddingEvidenceComposition,
    options
  );
}

export async function evaluateIndependentEmbeddingEvidenceCounterfactualWithCompanion(
  artifactPath: string,
  goldMapPath: string,
  companionGzipPath: string,
  companionManifestPath: string,
  options: Omit<EvaluateOptions, "cfTokenCompanion"> = {}
): Promise<SelectionCounterfactualCellMetrics> {
  return evaluateSelectionCounterfactualWithCompanion(
    artifactPath,
    goldMapPath,
    companionGzipPath,
    companionManifestPath,
    INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR,
    reconstructIndependentEmbeddingEvidenceComposition,
    options
  );
}

export async function evaluateNonlexicalUnitIntervalCompositionCounterfactual(
  artifactPath: string,
  goldMapPath: string,
  options: EvaluateOptions = {}
): Promise<SelectionCounterfactualCellMetrics> {
  return evaluateSelectionCounterfactual(
    artifactPath,
    goldMapPath,
    NONLEXICAL_UNIT_INTERVAL_COMPOSITION_OPERATOR,
    reconstructNonlexicalUnitIntervalComposition,
    options
  );
}

export async function evaluateNonlexicalUnitIntervalCompositionCounterfactualWithCompanion(
  artifactPath: string,
  goldMapPath: string,
  companionGzipPath: string,
  companionManifestPath: string,
  options: Omit<EvaluateOptions, "cfTokenCompanion"> = {}
): Promise<SelectionCounterfactualCellMetrics> {
  return evaluateSelectionCounterfactualWithCompanion(
    artifactPath,
    goldMapPath,
    companionGzipPath,
    companionManifestPath,
    NONLEXICAL_UNIT_INTERVAL_COMPOSITION_OPERATOR,
    reconstructNonlexicalUnitIntervalComposition,
    options
  );
}

export function resolveSelectionCounterfactualPromoteReady(
  cellA: SelectionCounterfactualCellMetrics,
  cellB: SelectionCounterfactualCellMetrics
): Readonly<{
  readonly promoteReady: boolean;
  readonly blockers: readonly string[];
}> {
  const blockers: string[] = [];
  if (!cellA.nonRegressive) blockers.push("cell_a_regressive_or_incomplete");
  if (!cellB.nonRegressive) blockers.push("cell_b_regressive_or_incomplete");
  if (cellA.anyAt5Gain + cellB.anyAt5Gain <= 0) {
    blockers.push("no_positive_cell");
  }
  return Object.freeze({
    promoteReady: blockers.length === 0,
    blockers: Object.freeze(blockers)
  });
}

export function summarizeCohortHitTransitions(
  transitions: readonly CounterfactualQuestionTransition[],
  cohortQuestionIds: ReadonlySet<string>
): Readonly<{
  readonly cohortSize: number;
  readonly evaluable: number;
  readonly missToHit: number;
  readonly hitToMiss: number;
  readonly stayHit: number;
  readonly stayMiss: number;
}> {
  let evaluable = 0;
  let missToHit = 0;
  let hitToMiss = 0;
  let stayHit = 0;
  let stayMiss = 0;
  for (const row of transitions) {
    if (!cohortQuestionIds.has(row.questionId)) continue;
    if (row.counterfactualHitAt5 === null) continue;
    evaluable += 1;
    if (!row.baselineHitAt5 && row.counterfactualHitAt5) missToHit += 1;
    else if (row.baselineHitAt5 && !row.counterfactualHitAt5) hitToMiss += 1;
    else if (row.baselineHitAt5) stayHit += 1;
    else stayMiss += 1;
  }
  return Object.freeze({
    cohortSize: cohortQuestionIds.size,
    evaluable,
    missToHit,
    hitToMiss,
    stayHit,
    stayMiss
  });
}

export function toQuestionTransition(
  evaluation: CounterfactualRecordEvaluation
): CounterfactualQuestionTransition {
  const baselineHitAt5 = anyGoldInHead(
    evaluation.baselineKeys,
    evaluation.goldObjectIds,
    5
  );
  return Object.freeze({
    questionId: evaluation.questionId,
    baselineHitAt5,
    counterfactualHitAt5: evaluation.counterfactualKeys === null
      ? null
      : anyGoldInHead(evaluation.counterfactualKeys, evaluation.goldObjectIds, 5),
    unseenTokenFailure: evaluation.unseenTokenFailure
  });
}

function evaluateCounterfactualRecord(
  record: SelectionBoundaryArtifactRecord,
  goldByQuestion: ReadonlyMap<string, GoldQuestion>,
  cfTokenCompanion: CfTokenCompanionLoad | undefined,
  reconstruct: CounterfactualReconstruct
): CounterfactualRecordEvaluation {
  reconstructFineAssessmentComposition(record.boundary);
  const baselineKeys = record.boundary.expected.candidate_keys;
  let counterfactualKeys: readonly string[] | null = null;
  let unseenTokenFailure = false;
  const companionSlice = cfTokenCompanion?.recordsByKey.get(
    companionRecordKey(record.question_id, record.invocation_index)
  );
  try {
    const reconstructed = reconstruct(record.boundary, {
      ...(companionSlice === undefined ? {} : {
        cfTokenCompanionAuxiliaryByContentSha256: auxiliaryEstimatesToMap(
          companionSlice.auxiliary_estimates
        )
      })
    });
    counterfactualKeys = counterfactualDeliveredCandidateKeys(
      reconstructed.result
    );
  } catch (error) {
    if (!isUnseenTokenFailure(error)) throw error;
    unseenTokenFailure = true;
  }
  const gold = goldByQuestion.get(record.question_id);
  if (gold === undefined) {
    throw new Error(
      `selection counterfactual missing gold map entry for ${record.question_id}`
    );
  }
  return Object.freeze({
    questionId: record.question_id,
    baselineKeys,
    counterfactualKeys,
    unseenTokenFailure,
    answerable: gold.answerable,
    goldObjectIds: gold.goldObjectIds
  });
}

function isUnseenTokenFailure(error: unknown): boolean {
  return error instanceof Error &&
    error.message === SELECTION_BOUNDARY_FIDELITY_MISMATCH;
}

async function loadGoldByQuestion(
  goldMapPath: string
): Promise<ReadonlyMap<string, GoldQuestion>> {
  const payload = JSON.parse(await readFile(goldMapPath, "utf8")) as Readonly<{
    readonly questions: readonly Readonly<{
      readonly question_id: string;
      readonly is_abstention: boolean;
      readonly premise_invalid: boolean;
      readonly gold_object_ids: readonly string[];
    }>[];
  }>;
  return new Map(payload.questions.map((question) => [
    question.question_id,
    Object.freeze({
      answerable: !question.is_abstention && !question.premise_invalid,
      goldObjectIds: Object.freeze([...question.gold_object_ids])
    })
  ]));
}
