import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  EvidenceConditionSchema,
  QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  QueryInterpretationProposalSchema,
  QuestionTimeIntervalSchema,
  QuestionTimePreferenceSchema,
  type CallerQueryCoordinates,
  type EvidenceCondition,
  type QueryInterpretationProposal,
  type QuestionTimePreference
} from "@do-soul/alaya-protocol";
import { digestOriginalQuery } from "./compile-query-identity.js";

/**
 * Deterministic ingress binder for caller-supplied query coordinates.
 * Binds `original_query_digest` and `interpretation_clock` once at trusted ingress
 * while degrading malformed date intervals or non-verbatim condition anchors safely.
 */
export function bindCallerQueryCoordinates(input: Readonly<{
  readonly queryText: string;
  readonly interpretationClock: string;
  readonly coordinates?: CallerQueryCoordinates;
}>): QueryInterpretationProposal | undefined {
  if (input.coordinates === undefined) return undefined;

  const questionTime = normalizeQuestionTime(input.coordinates.question_time, input.interpretationClock);
  const conditions = normalizeEvidenceConditions(input.coordinates.evidence_conditions, input.queryText);
  if (questionTime === undefined && conditions.length === 0) return undefined;

  const candidate = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    original_query_digest: digestOriginalQuery(input.queryText),
    producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
    producer_version: "1",
    ...(questionTime === undefined ? {} : { question_time: questionTime }),
    ...(conditions.length === 0 ? {} : {
      evidence_conditions: conditions,
      ...(input.coordinates.evidence_relation === "derived" ? { evidence_relation: "derived" as const } : {})
    })
  };
  const parsed = QueryInterpretationProposalSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function normalizeQuestionTime(
  questionTime: CallerQueryCoordinates["question_time"],
  interpretationClock: string
): QuestionTimePreference | undefined {
  if (questionTime === undefined) return undefined;
  const intervals = questionTime.intervals.filter((interval) =>
    QuestionTimeIntervalSchema.safeParse(interval).success
  );
  if (intervals.length === 0) return undefined;
  const parsed = QuestionTimePreferenceSchema.safeParse({
    interpretation_clock: interpretationClock,
    intervals
  });
  return parsed.success ? parsed.data : undefined;
}

function normalizeEvidenceConditions(
  conditions: CallerQueryCoordinates["evidence_conditions"],
  queryText: string
): readonly EvidenceCondition[] {
  if (conditions === undefined) return [];
  const valid: EvidenceCondition[] = [];
  const anchorSchema = EvidenceConditionSchema.unwrap().shape.anchors.unwrap().element;
  for (const condition of conditions) {
    const anchors = [...new Set(condition.anchors.filter(anchor =>
      anchorSchema.safeParse(anchor).success && queryText.includes(anchor)
    ))];
    if (condition.anchors.length > 0 && anchors.length === 0) continue;
    const parsed = EvidenceConditionSchema.safeParse({ ...condition, anchors });
    if (!parsed.success) continue;
    valid.push(parsed.data);
  }
  return valid;
}
