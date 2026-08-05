import {
  buildCoverageProjectionFormKey,
  type CandidateCoverageAtom,
  type CandidateCoverageReceipt
} from "../../delivery/fine-assessment-selection/coverage-atoms.js";
import type { AttributedFacilityCoverageMatch } from "../facility-objective.js";
import {
  verifyAttributedQueryFacilityDemand,
  type AttributedQueryFacilityDemandAtom,
  type AttributedQueryFacilityDemandReceipt
} from "../query-facility-demand.js";
import {
  REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID,
  regularRelationInflectionEquivalent
} from "./relation-inflection-alignment.js";
import { containsAlignedTokenSequence } from "./token-sequence-alignment.js";

export type AttributedFacilityMatchCandidate = Readonly<{
  readonly candidate_key: string;
  readonly object_id: string;
  readonly coverage: Readonly<CandidateCoverageReceipt>;
}>;

type FacilityAlignment = AttributedFacilityCoverageMatch["alignment_operator_id"];
type ProjectionAlignment = Readonly<{
  readonly formKeys: readonly string[];
  readonly operatorId: FacilityAlignment;
}>;

export function materializeAttributedFacilityMatches(params: Readonly<{
  readonly demand: Readonly<AttributedQueryFacilityDemandReceipt>;
  readonly candidates: readonly Readonly<AttributedFacilityMatchCandidate>[];
}>): ReadonlyMap<string, readonly Readonly<AttributedFacilityCoverageMatch>[]> {
  verifyAttributedQueryFacilityDemand(params.demand);
  const output = new Map<string, readonly Readonly<AttributedFacilityCoverageMatch>[]>();
  for (const candidate of [...params.candidates].sort(compareCandidates)) {
    if (output.has(candidate.candidate_key) ||
        candidate.coverage.candidate_key !== candidate.candidate_key) {
      throw new Error("facility match candidate identity mismatch");
    }
    output.set(candidate.candidate_key, materializeCandidateMatches(
      candidate,
      params.demand.demand_atoms
    ));
  }
  return output;
}

function materializeCandidateMatches(
  candidate: Readonly<AttributedFacilityMatchCandidate>,
  demands: readonly Readonly<AttributedQueryFacilityDemandAtom>[]
): readonly Readonly<AttributedFacilityCoverageMatch>[] {
  const matches = demands.flatMap((demand) => candidate.coverage.atoms.flatMap((atom) => {
    const alignment = matchingProjectionAlignment(candidate, demand, atom);
    if (alignment === null) return [];
    return [freezeMatch(demand, atom, alignment)];
  }));
  return Object.freeze(matches.sort(compareMatches));
}

function matchingProjectionAlignment(
  candidate: Readonly<AttributedFacilityMatchCandidate>,
  demand: Readonly<AttributedQueryFacilityDemandAtom>,
  atom: Readonly<CandidateCoverageAtom>
): ProjectionAlignment | null {
  if (demand.kind === "logical_object") {
    return atom.kind === "logical_object" && candidate.object_id === demand.value
      ? identityAlignment()
      : null;
  }
  if (demand.kind === "independent_evidence") {
    return atom.kind === "independent_evidence" && atom.evidence_object_id === demand.value
      ? identityAlignment()
      : null;
  }
  return matchingFieldProjectionForms(demand, atom);
}

function matchingFieldProjectionForms(
  demand: Readonly<AttributedQueryFacilityDemandAtom>,
  atom: Readonly<CandidateCoverageAtom>
): ProjectionAlignment | null {
  if (atom.kind !== "fact_projection" || atom.projection?.projection_kind !== "fact_key") {
    return null;
  }
  if (demand.kind !== "entity" && demand.kind !== "relation" && demand.kind !== "time") {
    return null;
  }
  const roles = FIELD_SLOT_ROLES[demand.kind];
  const exactKeys = new Set<string>();
  const relationInflectionKeys = new Set<string>();
  const pluralKeys = new Set<string>();
  for (const [slotIndex, slot] of (atom.projection.fact_slots ?? []).entries()) {
    if (!roles.has(slot.role)) continue;
    const alignment = fieldValueAlignment(
      slot.text,
      demand.value,
      atom.matched_fts_lanes?.includes("porter") === true,
      demand.kind
    );
    if (alignment === null) continue;
    const keys = alignmentKeys(alignment, {
      exactKeys,
      relationInflectionKeys,
      pluralKeys
    });
    for (const form of atom.projection.matched_fact_key_forms) {
      if (form.kind === "complete" || form.omitted_slot.slot_index !== slotIndex) {
        keys.add(buildCoverageProjectionFormKey(form));
      }
    }
  }
  if (exactKeys.size > 0) return projectionAlignment(exactKeys, "exact_token_sequence_v1");
  if (relationInflectionKeys.size > 0) {
    return projectionAlignment(
      relationInflectionKeys,
      REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID
    );
  }
  return pluralKeys.size > 0 ? projectionAlignment(pluralKeys, "porter_regular_plural_v1") : null;
}

function alignmentKeys(
  alignment: Exclude<FacilityAlignment, "identity_v1">,
  keys: Readonly<{
    readonly exactKeys: Set<string>;
    readonly relationInflectionKeys: Set<string>;
    readonly pluralKeys: Set<string>;
  }>
): Set<string> {
  if (alignment === "exact_token_sequence_v1") return keys.exactKeys;
  return alignment === REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID
    ? keys.relationInflectionKeys
    : keys.pluralKeys;
}

function fieldValueAlignment(
  fieldValue: string,
  demandValue: string,
  allowPorterAlignment: boolean,
  demandKind: "entity" | "relation" | "time"
): Exclude<FacilityAlignment, "identity_v1"> | null {
  const fieldTokens = canonicalTokens(fieldValue);
  const demandTokens = canonicalTokens(demandValue);
  if (demandTokens.length === 0 || demandTokens.length > fieldTokens.length) return null;
  const exact = containsAlignedTokenSequence(
    fieldTokens,
    demandTokens,
    (fieldToken, demandToken) => fieldToken === demandToken
  );
  if (exact) return "exact_token_sequence_v1";
  if (!allowPorterAlignment) return null;
  if (demandKind === "relation" &&
      regularRelationInflectionEquivalent(fieldValue, demandValue)) {
    return REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID;
  }
  if (demandKind !== "entity") return null;
  const aligned = containsAlignedTokenSequence(
    fieldTokens,
    demandTokens,
    regularPluralEquivalent
  );
  return aligned ? "porter_regular_plural_v1" : null;
}

function regularPluralEquivalent(left: string, right: string): boolean {
  return left === right || regularSingular(left) === right || regularSingular(right) === left;
}

function regularSingular(token: string): string | null {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") &&
      !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is")) {
    return token.slice(0, -1);
  }
  return null;
}

function canonicalTokens(value: string): readonly string[] {
  return Object.freeze(value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function freezeMatch(
  demand: Readonly<AttributedQueryFacilityDemandAtom>,
  atom: Readonly<CandidateCoverageAtom>,
  alignment: ProjectionAlignment
): Readonly<AttributedFacilityCoverageMatch> {
  return Object.freeze({
    demand_atom_id: demand.demand_atom_id,
    coverage_atom_id: atom.atom_id,
    independence_key: atom.independence_key,
    projection_form_keys: alignment.formKeys,
    alignment_operator_id: alignment.operatorId,
    match_strength: atom.strength
  });
}

function identityAlignment(): ProjectionAlignment {
  return Object.freeze({
    formKeys: Object.freeze([]),
    operatorId: "identity_v1"
  });
}

function projectionAlignment(
  keys: ReadonlySet<string>,
  operatorId: Exclude<FacilityAlignment, "identity_v1">
): ProjectionAlignment {
  return Object.freeze({
    formKeys: Object.freeze([...keys].sort(compareText)),
    operatorId
  });
}

function compareCandidates(
  left: Readonly<AttributedFacilityMatchCandidate>,
  right: Readonly<AttributedFacilityMatchCandidate>
): number {
  return compareText(left.candidate_key, right.candidate_key);
}

function compareMatches(
  left: Readonly<AttributedFacilityCoverageMatch>,
  right: Readonly<AttributedFacilityCoverageMatch>
): number {
  return compareText(left.demand_atom_id, right.demand_atom_id) ||
    compareText(left.coverage_atom_id, right.coverage_atom_id) ||
    compareText(left.independence_key, right.independence_key);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

const FIELD_SLOT_ROLES = Object.freeze({
  entity: new Set(["subject", "value", "qualifier"]),
  relation: new Set(["relation"]),
  time: new Set(["time"])
} as const);
