import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type Proposition,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import type {
  EvidenceAssessmentInput,
  EvidenceIdentityContext,
  EvidenceObservation,
  PropositionDemand,
  WitnessTemplate
} from "../../../../recall/conditional-field/evidence/assess-support.js";

export const QUERY_ID = "failed-deployment";
export const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
export const SOURCE_REVISION = "rev-1";
export const AS_OF = "2026-09-06T12:00:00.000Z";
export const OPEN_VALIDITY: RelationValidity = {
  kind: "open",
  valid_from: "2020-01-01T00:00:00.000Z"
};

export function identityContext(
  overrides: Partial<EvidenceIdentityContext> = {}
): EvidenceIdentityContext {
  return {
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    source_revision: SOURCE_REVISION,
    hypothesis_id: "h0",
    binding_context: "default",
    time_state: "as_of",
    jurisdiction: "workspace",
    as_of: AS_OF,
    permitted_timeless_policy_ids: new Set<string>(),
    ...overrides
  };
}

export function observation(
  overrides: Partial<EvidenceObservation> & Pick<EvidenceObservation, "observation_id" | "evidence_id" | "premise_id" | "proposition_id">
): EvidenceObservation {
  const context = identityContext();
  return {
    source_id: "src",
    source_revision: context.source_revision,
    query_id: context.query_id,
    snapshot_id: context.snapshot_id,
    hypothesis_id: context.hypothesis_id,
    binding_context: context.binding_context,
    time_state: context.time_state,
    jurisdiction: context.jurisdiction,
    polarity: "supports",
    access: "eligible",
    validity: OPEN_VALIDITY,
    as_of: context.as_of,
    lineage_id: overrides.evidence_id,
    independence_key: overrides.evidence_id,
    association_milligrades: 0,
    cost: 0,
    ...overrides
  };
}

export function proposition(
  id: string,
  kind: string,
  arguments_: readonly string[] = []
): Proposition {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    proposition_id: id,
    kind,
    arguments: arguments_
  };
}

export function template(
  witnessId: string,
  premises: readonly string[],
  cost: number
): WitnessTemplate {
  return { witness_id: witnessId, premises, cost };
}

export function demand(
  id: string,
  kind: string,
  templates: readonly WitnessTemplate[],
  arguments_: readonly string[] = []
): PropositionDemand {
  return { proposition: proposition(id, kind, arguments_), templates };
}

export function assessmentInput(
  overrides: Partial<EvidenceAssessmentInput> & Pick<
    EvidenceAssessmentInput,
    "observations" | "propositions"
  >
): EvidenceAssessmentInput {
  return {
    ...identityContext(),
    work_limit: 10_000,
    ...overrides
  };
}
