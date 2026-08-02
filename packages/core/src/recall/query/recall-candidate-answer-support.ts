import type { MemoryEntry, RecallCandidate } from "@do-soul/alaya-protocol";
import type {
  RecallAnswerShape,
  RecallAnswerShapePlan
} from "./recall-answer-shape-plan.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { splitLexicalTokens } from "./recall-query-probes.js";
import type {
  RecallVerifiedUserAssertionContext
} from "./recall-user-assertion-context.js";
import {
  assessRecallScalarBinding,
  matchRecallRelationTerms,
  resolveRecallRelationStatus,
  resolveRecallScalarEventStatus,
  resolveRecallTargetStatus,
  supportsRecallScalarValue
} from "./recall-answer-scalar-binding.js";

export type RecallCandidateAnswerSupportStatus =
  | "compatible"
  | "value_only"
  | "unsupported"
  | "observation_only"
  | "ineligible";

export interface RecallCandidateAnswerAuthority {
  readonly schema_version: 1;
  readonly provenance_status: "verified_user_assertion" | "unverified";
  readonly subject_status: "bound" | "conflicted" | "unknown";
  readonly target_status: "bound" | "partial" | "missing";
  readonly relation_status: "bound" | "conflicted" | "missing";
  readonly event_status: "asserted" | "prospective" | "negated" | "reversed";
  readonly time_status: "not_requested" | "compatible" | "conflicted" | "unknown";
  readonly binding_status: "unique" | "missing_or_ambiguous";
  readonly behavior_eligible: boolean;
  readonly evidence_ref: string | null;
}

export interface RecallCandidateAnswerSupport {
  readonly schema_version: 1;
  readonly shape: RecallAnswerShape;
  readonly status: RecallCandidateAnswerSupportStatus;
  readonly eligible: boolean;
  readonly value_supported: boolean;
  readonly target_supported: boolean;
  readonly relation_supported: boolean;
  readonly matched_target_terms: readonly string[];
  readonly matched_relation_terms: readonly string[];
  readonly authority?: Readonly<RecallCandidateAnswerAuthority>;
}

export interface RecallCandidateAnswerSupportContext {
  readonly queryProbes?: Readonly<RecallQueryProbes>;
  readonly verifiedUserAssertionContext?: Readonly<RecallVerifiedUserAssertionContext>;
}

export type RecallCandidateAnswerCompatibility = Readonly<{
  readonly shape: RecallAnswerShape;
  readonly status: Exclude<RecallCandidateAnswerSupportStatus, "ineligible">;
  readonly value_supported: boolean;
  readonly target_supported: boolean;
  readonly relation_supported: boolean;
  readonly matched_target_terms: readonly string[];
  readonly matched_relation_terms: readonly string[];
}>;

const THIRD_PARTY_SUBJECT =
  /\bmy\s+(?:friend|sister|brother|mother|father|mom|dad|wife|husband|partner|colleague|coworker|roommate|daughter|son|doctor)\b|\b(?:he|she|they|his|her|their)\b/iu;
const SELF_SUBJECT =
  /\b(?:i|me|my|mine|myself)\b|\bi['’](?:m|ve|d|ll)\b/iu;

export function buildRecallCandidateAnswerSupport(
  plan: Readonly<RecallAnswerShapePlan>,
  entry: Readonly<MemoryEntry>,
  objectKind: RecallCandidate["object_kind"],
  context: Readonly<RecallCandidateAnswerSupportContext> = {}
): Readonly<RecallCandidateAnswerSupport> | null {
  const compatibility = assessRecallCandidateAnswerCompatibility(plan, entry);
  if (compatibility === null) return null;
  const eligible = objectKind === "memory_entry" && entry.evidence_refs.length > 0;
  if (!eligible) {
    return freezeSupport({
      shape: compatibility.shape,
      status: "ineligible",
      eligible: false,
      valueSupported: compatibility.value_supported,
      targetSupported: compatibility.target_supported,
      relationSupported: compatibility.relation_supported,
      matchedTargetTerms: compatibility.matched_target_terms,
      matchedRelationTerms: compatibility.matched_relation_terms
    });
  }
  if (compatibility.status === "observation_only") {
    return freezeCompatibilitySupport(compatibility, eligible);
  }
  return freezeSupport({
    shape: compatibility.shape,
    status: compatibility.status,
    eligible,
    valueSupported: compatibility.value_supported,
    targetSupported: compatibility.target_supported,
    relationSupported: compatibility.relation_supported,
    matchedTargetTerms: compatibility.matched_target_terms,
    matchedRelationTerms: compatibility.matched_relation_terms,
    authority: buildScalarAuthority(
      plan,
      entry,
      compatibility.value_supported,
      context
    )
  });
}

function freezeCompatibilitySupport(
  compatibility: Readonly<RecallCandidateAnswerCompatibility>,
  eligible: boolean
): Readonly<RecallCandidateAnswerSupport> {
  return freezeSupport({
    shape: compatibility.shape,
    status: compatibility.status,
    eligible,
    valueSupported: compatibility.value_supported,
    targetSupported: compatibility.target_supported,
    relationSupported: compatibility.relation_supported,
    matchedTargetTerms: compatibility.matched_target_terms,
    matchedRelationTerms: compatibility.matched_relation_terms
  });
}

export function assessRecallCandidateAnswerCompatibility(
  plan: Readonly<RecallAnswerShapePlan>,
  entry: Readonly<MemoryEntry>
): Readonly<RecallCandidateAnswerCompatibility> | null {
  if (plan.status !== "high_confidence" || plan.shape === null) return null;
  const contentTokens = new Set(splitLexicalTokens(entry.content));
  const matchedTargetTerms = plan.target_terms.filter((term) => contentTokens.has(term));
  const matchedRelationTerms = matchRecallRelationTerms(plan.relation_terms, contentTokens);
  const targetSupported = matchedTargetTerms.length > 0;
  const relationSupported =
    plan.relation_terms.length === 0 || matchedRelationTerms.length > 0;
  if (isAggregateShape(plan.shape)) {
    return freezeCompatibility({
      shape: plan.shape,
      status: "observation_only",
      targetSupported,
      relationSupported,
      matchedTargetTerms,
      matchedRelationTerms
    });
  }
  const valueSupported = supportsRecallScalarValue(plan.shape, entry.content);
  return freezeCompatibility({
    shape: plan.shape,
    status: valueSupported && targetSupported && relationSupported
      ? "compatible"
      : valueSupported ? "value_only" : "unsupported",
    valueSupported,
    targetSupported,
    relationSupported,
    matchedTargetTerms,
    matchedRelationTerms
  });
}

function buildScalarAuthority(
  plan: Readonly<RecallAnswerShapePlan>,
  entry: Readonly<MemoryEntry>,
  valueSupported: boolean,
  context: Readonly<RecallCandidateAnswerSupportContext>
): Readonly<RecallCandidateAnswerAuthority> {
  const verified = isRecallVerifiedUserAssertionContext(
    entry,
    context.verifiedUserAssertionContext
  )
    ? context.verifiedUserAssertionContext
    : undefined;
  const assertionContext = verified?.user_context ?? entry.content;
  const tokens = new Set(splitLexicalTokens(assertionContext));
  const binding = assessRecallScalarBinding(
    plan,
    context.queryProbes,
    assertionContext,
    verified?.assertion_text ?? entry.content
  );
  const targetStatus = binding?.target_status ??
    resolveRecallTargetStatus(plan.target_terms, tokens);
  const relationStatus = binding?.relation_status ??
    resolveRecallRelationStatus(plan.relation_terms, tokens);
  const subjectStatus = binding?.subject_status ??
    resolveSubjectStatus(context.queryProbes, assertionContext);
  const eventStatus = binding?.event_status ?? resolveRecallScalarEventStatus(assertionContext);
  const timeStatus = binding?.time_status ?? resolveTimeStatus(context.queryProbes);
  const bindingStatus = binding === null ? "missing_or_ambiguous" as const : "unique" as const;
  const provenanceStatus = verified === undefined
    ? "unverified" as const
    : "verified_user_assertion" as const;
  const behaviorEligible = valueSupported &&
    provenanceStatus === "verified_user_assertion" &&
    subjectStatus === "bound" &&
    targetStatus === "bound" &&
    relationStatus === "bound" &&
    eventStatus === "asserted" &&
    bindingStatus === "unique" &&
    (timeStatus === "not_requested" || timeStatus === "compatible");
  return Object.freeze({
    schema_version: 1,
    provenance_status: provenanceStatus,
    subject_status: subjectStatus,
    target_status: targetStatus,
    relation_status: relationStatus,
    event_status: eventStatus,
    time_status: timeStatus,
    binding_status: bindingStatus,
    behavior_eligible: behaviorEligible,
    evidence_ref: verified?.evidence_ref ?? null
  });
}

export function isRecallVerifiedUserAssertionContext(
  entry: Readonly<MemoryEntry>,
  context: Readonly<RecallVerifiedUserAssertionContext> | undefined
): context is Readonly<RecallVerifiedUserAssertionContext> {
  if (
    context === undefined ||
    context.schema_version !== 1 ||
    context.source_role !== "user" ||
    !entry.evidence_refs.includes(context.evidence_ref) ||
    context.assertion_text !== entry.content.trim()
  ) return false;
  const first = context.user_context.indexOf(context.assertion_text);
  return first >= 0 &&
    context.user_context.indexOf(context.assertion_text, first + 1) < 0;
}

function resolveSubjectStatus(
  probes: Readonly<RecallQueryProbes> | undefined,
  text: string
): RecallCandidateAnswerAuthority["subject_status"] {
  if (probes?.subject_hints.includes("self_reference") !== true) return "unknown";
  if (THIRD_PARTY_SUBJECT.test(text)) return "conflicted";
  return SELF_SUBJECT.test(text) ? "bound" : "unknown";
}

function resolveTimeStatus(
  probes: Readonly<RecallQueryProbes> | undefined
): RecallCandidateAnswerAuthority["time_status"] {
  const requested = probes?.date_terms ?? [];
  if (requested.length === 0) return "not_requested";
  return "unknown";
}

function isAggregateShape(shape: RecallAnswerShape): boolean {
  return shape === "count" || shape === "sum" || shape === "distinct_entities";
}

function freezeCompatibility(input: Readonly<{
  shape: RecallAnswerShape;
  status: Exclude<RecallCandidateAnswerSupportStatus, "ineligible">;
  valueSupported?: boolean;
  targetSupported?: boolean;
  relationSupported?: boolean;
  matchedTargetTerms?: readonly string[];
  matchedRelationTerms?: readonly string[];
}>): Readonly<RecallCandidateAnswerCompatibility> {
  return Object.freeze({
    shape: input.shape,
    status: input.status,
    value_supported: input.valueSupported ?? false,
    target_supported: input.targetSupported ?? false,
    relation_supported: input.relationSupported ?? false,
    matched_target_terms: Object.freeze([...(input.matchedTargetTerms ?? [])]),
    matched_relation_terms: Object.freeze([...(input.matchedRelationTerms ?? [])])
  });
}

function freezeSupport(input: Readonly<{
  shape: RecallAnswerShape;
  status: RecallCandidateAnswerSupportStatus;
  eligible: boolean;
  valueSupported: boolean;
  targetSupported: boolean;
  relationSupported: boolean;
  matchedTargetTerms: readonly string[];
  matchedRelationTerms: readonly string[];
  authority?: Readonly<RecallCandidateAnswerAuthority>;
}>): Readonly<RecallCandidateAnswerSupport> {
  return Object.freeze({
    schema_version: 1,
    shape: input.shape,
    status: input.status,
    eligible: input.eligible,
    value_supported: input.valueSupported,
    target_supported: input.targetSupported,
    relation_supported: input.relationSupported,
    matched_target_terms: Object.freeze([...input.matchedTargetTerms]),
    matched_relation_terms: Object.freeze([...input.matchedRelationTerms]),
    ...(input.authority === undefined ? {} : { authority: input.authority })
  });
}
