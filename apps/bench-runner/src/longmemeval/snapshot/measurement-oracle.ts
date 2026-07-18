import type { LongMemEvalQuestion } from "../ingestion/dataset.js";
import type { LongMemEvalSnapshotSidecarFile } from "./materialize.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  type LongMemEvalSidecarEntry
} from "../runner/runner-scoring.js";
import { classifyLongMemEvalDatasetCohort } from
  "../selection/dataset-cohort.js";
import { buildLongMemEvalSourceDatesBySession } from
  "../ingestion/source-time.js";
import {
  createEmptyLongMemEvalSeedDropReasons,
  type LongMemEvalSeedDropReasons
} from "../extraction/seed-fuel/seed-drop-reasons.js";

export interface SnapshotQuestionMeasurementOracle {
  readonly answer: string;
  readonly answerSessionIds: readonly string[];
  readonly sourceDatesBySession: ReadonlyMap<string, string>;
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly isAbstention: boolean;
  readonly goldMemoryIds: readonly string[];
  readonly seedDropReasons: LongMemEvalSeedDropReasons;
}

export type SnapshotMeasurementOracleAccessor = (
  questionId: string
) => SnapshotQuestionMeasurementOracle | undefined;

export function buildSnapshotMeasurementOracle(
  questions: readonly LongMemEvalQuestion[],
  sidecar: LongMemEvalSnapshotSidecarFile
): SnapshotMeasurementOracleAccessor {
  if (questions.length !== sidecar.questions.length) {
    throw new Error("snapshot measurement oracle question count mismatch");
  }
  const oracles = new Map<string, () => SnapshotQuestionMeasurementOracle>();
  questions.forEach((question, index) => {
    const snapshotQuestion = sidecar.questions[index];
    if (snapshotQuestion?.questionId !== question.question_id ||
        oracles.has(question.question_id)) {
      throw new Error("snapshot measurement oracle question identity mismatch");
    }
    oracles.set(question.question_id, buildQuestionOracleFactory(
      question,
      snapshotQuestion
    ));
  });
  return Object.freeze((questionId: string) => oracles.get(questionId)?.());
}

function buildQuestionOracleFactory(
  question: LongMemEvalQuestion,
  snapshotQuestion: LongMemEvalSnapshotSidecarFile["questions"][number]
): () => SnapshotQuestionMeasurementOracle {
  const entries = snapshotQuestion.sidecar;
  const sidecar = new Map<string, LongMemEvalSidecarEntry>();
  for (const entry of entries) {
    const key = buildLongMemEvalSidecarKey(entry.objectKind, entry.objectId);
    if (sidecar.has(key)) {
      throw new Error(`snapshot measurement oracle repeats ${key}`);
    }
    sidecar.set(key, Object.freeze({ ...entry }));
  }
  const answerSessionIds = Object.freeze([...question.answer_session_ids]);
  const sourceDates = [...buildLongMemEvalSourceDatesBySession(question)];
  const sidecarEntries = [...sidecar];
  const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(
    sidecar,
    new Set(answerSessionIds)
  );
  const isAbstention = classifyLongMemEvalDatasetCohort(question) === "abstention";
  const seedDropReasons = Object.freeze({
    ...(snapshotQuestion.answerSeedDropReasons ?? createEmptyLongMemEvalSeedDropReasons())
  });
  return () => Object.freeze({
    answer: question.answer,
    answerSessionIds,
    sourceDatesBySession: new Map(sourceDates),
    sidecar: new Map(sidecarEntries),
    isAbstention,
    goldMemoryIds,
    seedDropReasons
  });
}
