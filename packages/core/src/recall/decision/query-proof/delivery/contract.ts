import { compareText } from "../../../../shared/compare-text.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../field/field-identity.js";
import type { QueryHoleImpactV1 } from "../../../query/canonical-query/compilation.js";
import type { FiniteValue } from "../proof/oracle/contract.js";

export const QUERY_PROOF_DELIVERY_PACK_OPERATOR_ID =
  "query_proof_delivery_pack_v1" as const;

export const DELIVERY_PACK_MODES = Object.freeze([
  "certified",
  "best_effort_uncertified",
  "abstained",
  "unsupported",
  "conflict"
] as const);

export type DeliveryPackModeV1 = (typeof DELIVERY_PACK_MODES)[number];

export const DELIVERY_ALLOWED_CLAIMS = Object.freeze([
  "completeness_prohibition",
  "scalar",
  "scoped_all_observable",
  "scoped_extremum",
  "uncertainty_exposure"
] as const);

export type DeliveryAllowedClaimV1 = (typeof DELIVERY_ALLOWED_CLAIMS)[number];

export const DELIVERY_CONSUMER_ACTIONS = Object.freeze([
  "parse_as_certified",
  "claim_scalar",
  "claim_scoped_extremum",
  "claim_scoped_all_observable",
  "infer_completeness_from_packet_size",
  "hidden_filter",
  "hidden_reorder",
  "hidden_membership_cut",
  "mark_used"
] as const);

export type DeliveryConsumerActionV1 = (typeof DELIVERY_CONSUMER_ACTIONS)[number];

export type DeliveryAnswerKindV1 =
  | "scalar"
  | "extremum"
  | "all_observable"
  | "none";

export type DeliveryPackHoleV1 = Readonly<{
  readonly provenance: string;
  readonly code: string;
  readonly impacts: readonly QueryHoleImpactV1[];
}>;

export type DeliveryPackConflictV1 = Readonly<{
  readonly conflict_id: string;
  readonly kind: string;
  readonly coordinate_ids: readonly string[];
}>;

export type DeliveryPackBindingV1 = Readonly<{
  readonly binding_id: string;
  readonly value: FiniteValue;
}>;

export type DeliveryPackPropositionV1 = Readonly<{
  readonly proposition_id: string;
  readonly support: "supports" | "absent" | "unknown" | "refutes" | "conflict";
}>;

export type DeliveryPackEvidenceGroupV1 = Readonly<{
  readonly group_id: string;
  readonly member_keys: readonly string[];
  readonly correlation: "certified_independent" | "unknown" | "correlated";
}>;

export type DeliveryCompletenessScopeV1 = Readonly<{
  readonly kind: "all_observable";
  readonly scope: string;
  readonly principal: string;
  readonly observer_contract: string;
  readonly snapshot_bind: "Sigma_q";
}>;

export type DeliveryPrincipalScopeV1 = Readonly<{
  readonly principal: string | null;
  readonly effective_as_of: string | null;
  readonly governance_frontier: string | null;
  readonly delivery_interference: false;
}>;

export type DeliveryPackInputV1 = Readonly<{
  readonly mode: DeliveryPackModeV1;
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly decision_contract_digest: RecallFieldDigest;
  readonly capture_identity_digest: string;
  readonly selected_candidates: readonly string[];
  readonly answer_kind: DeliveryAnswerKindV1;
  readonly answer_bindings: readonly DeliveryPackBindingV1[];
  readonly propositions: readonly DeliveryPackPropositionV1[];
  readonly evidence_groups: readonly DeliveryPackEvidenceGroupV1[];
  readonly holes: readonly DeliveryPackHoleV1[];
  readonly conflicts: readonly DeliveryPackConflictV1[];
  readonly completeness_scope: DeliveryCompletenessScopeV1 | null;
  readonly principal_scope: DeliveryPrincipalScopeV1;
}>;

export type DeliveryPackV1 = Readonly<DeliveryPackInputV1 & {
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_PROOF_DELIVERY_PACK_OPERATOR_ID;
  readonly allowed_claims: readonly DeliveryAllowedClaimV1[];
  readonly utilization: "delivered_not_used";
  readonly prefix_authority: "prefix_sk";
  readonly pack_digest: RecallFieldDigest;
}>;

export type DeliveryConsumerVerdictV1 =
  | Readonly<{ readonly status: "accepted" }>
  | Readonly<{ readonly status: "rejected"; readonly reason: string }>;

export const NON_INTERFERING_PRINCIPAL_SCOPE: DeliveryPrincipalScopeV1 = Object.freeze({
  principal: null,
  effective_as_of: null,
  governance_frontier: null,
  delivery_interference: false as const
});

export const SEAL_UNBOUND_HOLE: DeliveryPackHoleV1 = Object.freeze({
  provenance: "delivery_pack",
  code: "seal_unbound",
  impacts: Object.freeze(["blocks_certified_delivery"] as const)
});

export function unavailableDeliveryDigest(field: string): RecallFieldDigest {
  return digestRecallFieldIdentity({ status: "unavailable", field });
}

export function hasHoleImpact(
  holes: readonly DeliveryPackHoleV1[],
  impact: QueryHoleImpactV1
): boolean {
  return holes.some((hole) => hole.impacts.includes(impact));
}

export function isCompletenessScope(
  value: unknown
): value is DeliveryCompletenessScopeV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<DeliveryCompletenessScopeV1>;
  return record.kind === "all_observable"
    && record.snapshot_bind === "Sigma_q"
    && isToken(record.scope)
    && isToken(record.principal)
    && isToken(record.observer_contract);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

export function deriveAllowedClaims(
  input: DeliveryPackInputV1
): readonly DeliveryAllowedClaimV1[] {
  const claims = new Set<DeliveryAllowedClaimV1>(["uncertainty_exposure"]);
  const completenessLicensed = input.mode === "certified"
    && input.answer_kind === "all_observable"
    && isCompletenessScope(input.completeness_scope)
    && !hasHoleImpact(input.holes, "blocks_completeness_claim");
  if (!completenessLicensed) claims.add("completeness_prohibition");
  if (input.mode === "certified" && !hasHoleImpact(input.holes, "blocks_certified_delivery")) {
    if (input.answer_kind === "scalar") claims.add("scalar");
    if (input.answer_kind === "extremum") claims.add("scoped_extremum");
    if (completenessLicensed) claims.add("scoped_all_observable");
  }
  return Object.freeze([...claims].sort(compareText));
}

export function digestDeliveryPackBody(
  body: Omit<DeliveryPackV1, "pack_digest">
): RecallFieldDigest {
  return digestRecallFieldIdentity(body);
}
