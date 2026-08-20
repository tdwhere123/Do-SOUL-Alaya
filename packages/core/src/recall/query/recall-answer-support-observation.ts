import { createHash } from "node:crypto";
import type {
  RecallCandidateAnswerSupport,
  RecallCandidateAnswerSupportStatus,
  RecallCandidateAnswerCompatibility
} from "./recall-candidate-answer-support.js";
import type {
  RecallVerifiedUserAssertionContext
} from "./recall-user-assertion-context.js";

export type RecallAnswerSupportProjectionKind =
  | "atomic_assertion"
  | "turn_projection";

export interface RecallVerifiedUserSupportSource {
  readonly schema_version: 1;
  readonly source_role: "user";
  readonly projection_kind: RecallAnswerSupportProjectionKind;
  readonly evidence_ref: string;
  readonly support_identity: string | null;
}

export interface RecallAnswerSupportObservation {
  readonly schema_version: 1;
  readonly source_identity: string;
  readonly support_identity: string | null;
  readonly evidence_ref: string;
  readonly source_role: "user";
  readonly projection_kind: RecallAnswerSupportProjectionKind;
  readonly provenance_status:
    | "verified_user_assertion"
    | "verified_user_turn";
  readonly query_status: RecallCandidateAnswerSupportStatus | "unresolved";
  readonly event_status:
    | "asserted"
    | "prospective"
    | "negated"
    | "reversed"
    | "unknown";
  readonly time_status:
    | "not_requested"
    | "compatible"
    | "conflicted"
    | "unknown";
  readonly behavior_eligible: boolean;
}

export function buildVerifiedAssertionSupportSource(
  context: Readonly<RecallVerifiedUserAssertionContext>
): Readonly<RecallVerifiedUserSupportSource> {
  return Object.freeze({
    schema_version: 1,
    source_role: "user",
    projection_kind: "atomic_assertion",
    evidence_ref: context.evidence_ref,
    support_identity: buildAssertionSupportIdentity(context)
  });
}

export function buildRecallAnswerSupportObservations(params: Readonly<{
  readonly source?: Readonly<RecallVerifiedUserSupportSource>;
  readonly compatibility: Readonly<RecallCandidateAnswerCompatibility> | null;
  readonly support: Readonly<RecallCandidateAnswerSupport> | null;
}>): readonly Readonly<RecallAnswerSupportObservation>[] {
  const source = params.source;
  if (source === undefined) return Object.freeze([]);
  const authority = params.support?.authority;
  const atomic = source.projection_kind === "atomic_assertion";
  return Object.freeze([Object.freeze({
    schema_version: 1,
    source_identity: `evidence_ref:${source.evidence_ref}`,
    support_identity: source.support_identity,
    evidence_ref: source.evidence_ref,
    source_role: source.source_role,
    projection_kind: source.projection_kind,
    provenance_status: atomic
      ? "verified_user_assertion"
      : "verified_user_turn",
    query_status: params.compatibility?.status ?? "unresolved",
    event_status: authority?.event_status ?? "unknown",
    time_status: authority?.time_status ?? "unknown",
    behavior_eligible: atomic &&
      source.support_identity !== null &&
      authority?.evidence_ref === source.evidence_ref &&
      authority.behavior_eligible
  })]);
}

function buildAssertionSupportIdentity(
  context: Readonly<RecallVerifiedUserAssertionContext>
): string {
  const digest = createHash("sha256")
    .update(context.assertion_text.trim(), "utf8")
    .digest("hex");
  return `verified_user_assertion:${context.evidence_ref}:sha256:${digest}`;
}
