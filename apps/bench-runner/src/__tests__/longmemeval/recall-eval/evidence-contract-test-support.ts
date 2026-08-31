import { buildQuestionDiagnostic } from "../../../diagnostics/diagnostics.js";

export function diagnostic(input: {
  readonly id: string;
  readonly gold?: readonly string[];
  readonly abstention?: boolean;
  readonly recallResult?: unknown;
  readonly seedDropReasons?: { candidate_absent: number; materialization_drop: number };
}) {
  return buildQuestionDiagnostic({
    questionId: input.id,
    goldMemoryIds: input.gold ?? [],
    answerSessionIds: [],
    deliveredResults: [],
    hitAt1: false,
    hitAt5: false,
    hitAt10: false,
    isAbstention: input.abstention,
    degradationReason: null,
    embeddingMode: "disabled",
    recallResult: input.recallResult ?? null,
    seedDropReasons: input.seedDropReasons
  });
}

export function completeAnswerFeatures(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    content: "Alice works as an engineer.",
    evidence_gist: "Alice said she works as an engineer.",
    evidence_gist_truncated: true,
    domain_tags: ["occupation"],
    evidence_refs: ["evidence-alice-work"],
    facet_tags: [{ facet: "occupation_work", value: "engineer" }],
    canonical_entities: ["alice", "engineer"],
    projection_schema_version: 1,
    event_time_start: "2026-07-01T00:00:00.000Z",
    event_time_end: "2026-07-01T01:00:00.000Z",
    valid_from: "2026-07-01T00:00:00.000Z",
    valid_to: null,
    time_precision: "day",
    time_source: "session_timestamp",
    preference_subject: "alice",
    preference_predicate: "works_as",
    preference_object: "engineer",
    preference_category: "occupation",
    preference_polarity: "positive",
    ...overrides
  };
}
