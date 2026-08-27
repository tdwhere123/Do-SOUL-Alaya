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
  REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID
} from "./relation-inflection-alignment.js";
import {
  alignFactFrameSemanticFactor,
  projectFactFrameSemanticFactors,
  STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID,
  type FactFrameSemanticAlignment,
  type FactFrameSemanticFactor
} from "../fact-frame-semantic-factors.js";
import { isContentOwnedAssertionFactAtom } from
  "../../delivery/fine-assessment-selection/content-owned-fact-key.js";
import { compareText } from "../../../shared/compare-text.js";

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
  if (demand.semantic_factor === undefined) return null;
  const keys = {
    exactKeys: new Set<string>(),
    relationInflectionKeys: new Set<string>(),
    pluralKeys: new Set<string>(),
    storedSlotRelationKeys: new Set<string>()
  };
  collectAlignedFormKeys(demand.semantic_factor, demand.kind, demand.attribution_kind,
    atom, keys);
  return preferredFieldAlignment(keys);
}

function collectAlignedFormKeys(
  demandFactor: Readonly<FactFrameSemanticFactor>,
  demandKind: "entity" | "relation" | "time",
  attributionKind: AttributedQueryFacilityDemandAtom["attribution_kind"],
  atom: Readonly<CandidateCoverageAtom>,
  keys: Readonly<{
    readonly exactKeys: Set<string>;
    readonly relationInflectionKeys: Set<string>;
    readonly pluralKeys: Set<string>;
    readonly storedSlotRelationKeys: Set<string>;
  }>
): void {
  const projection = atom.projection;
  if (projection === null) return;
  const candidateFactors = projectFactFrameSemanticFactors(projection.fact_slots ?? []);
  for (const candidateFactor of candidateFactors) {
    const ownedAssertion = isContentOwnedAssertionFactAtom(atom);
    const alignment = alignFactFrameSemanticFactor({
      candidate: candidateFactor,
      demand: demandFactor,
      demand_kind: demandKind,
      allow_porter: atom.matched_fts_lanes?.includes("porter") === true,
      allow_owned_assertion_relation_inflection: ownedAssertion,
      allow_owned_assertion_role_neutrality: ownedAssertion,
      require_exact_role: attributionKind === "typed_fact_frame"
    });
    if (alignment === null) continue;
    const bucket = alignmentKeys(alignment, keys);
    for (const form of projection.matched_fact_key_forms) {
      if (form.kind === "complete" || form.omitted_slot.slot_index !== candidateFactor.slot_index) {
        bucket.add(buildCoverageProjectionFormKey(form));
      }
    }
  }
}

function preferredFieldAlignment(keys: Readonly<{
  readonly exactKeys: ReadonlySet<string>;
  readonly relationInflectionKeys: ReadonlySet<string>;
  readonly pluralKeys: ReadonlySet<string>;
  readonly storedSlotRelationKeys: ReadonlySet<string>;
}>): ProjectionAlignment | null {
  if (keys.exactKeys.size > 0) {
    return projectionAlignment(keys.exactKeys, "exact_token_sequence_v1");
  }
  if (keys.relationInflectionKeys.size > 0) {
    return projectionAlignment(
      keys.relationInflectionKeys,
      REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID
    );
  }
  if (keys.pluralKeys.size > 0) {
    return projectionAlignment(keys.pluralKeys, "porter_regular_plural_v1");
  }
  return keys.storedSlotRelationKeys.size > 0
    ? projectionAlignment(
      keys.storedSlotRelationKeys,
      STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID
    )
    : null;
}

function alignmentKeys(
  alignment: FactFrameSemanticAlignment,
  keys: Readonly<{
    readonly exactKeys: Set<string>;
    readonly relationInflectionKeys: Set<string>;
    readonly pluralKeys: Set<string>;
    readonly storedSlotRelationKeys: Set<string>;
  }>
): Set<string> {
  if (alignment === "exact_token_sequence_v1") return keys.exactKeys;
  if (alignment === REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID) {
    return keys.relationInflectionKeys;
  }
  return alignment === STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID
    ? keys.storedSlotRelationKeys
    : keys.pluralKeys;
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
