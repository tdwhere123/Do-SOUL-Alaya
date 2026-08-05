import {
  mergeFtsLaneIds,
  type AssociativeFactSlotRole,
  type FtsLaneId
} from "@do-soul/alaya-protocol";
import { clamp01 } from "../../../shared/clamp.js";
import { buildRecallLogicalObjectKey } from
  "../../runtime/recall-service-helpers.js";
import type {
  RecallEvidenceProjectionMatchReceipt,
  RecallEvidenceSemanticActivationReceipt,
  RecallEvidenceSemanticProjectionReceipt,
  RecallEvidenceSemanticWinnerReceipt,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import type { CandidateActivationReceipt } from
  "../../scoring/candidate-semantic-activation.js";
import {
  resolveRecallCandidateSemanticActivation,
  type RecallCandidateActivationInput,
  type RecallCandidateActivationSupplementary
} from "../../scoring/activation/candidate-semantic-activation-context.js";

export const COVERAGE_ATOM_OPERATOR_ID =
  "attributed_coverage_atoms_v1";

export type CoverageDemandRole = AssociativeFactSlotRole | "complete";
export type CoverageObservationChannel = "evidence_fts" | "evidence_semantic";

export function buildCoverageProjectionFormKey(
  form: RecallEvidenceSemanticProjectionReceipt["matched_fact_key_forms"][number]
): string {
  return form.kind === "complete"
    ? "complete"
    : `leave_one_slot_out:${form.omitted_slot.slot_index}:${form.omitted_slot.role}`;
}

export type CandidateCoverageAtom = Readonly<{
  readonly atom_id: string;
  readonly kind: "logical_object" | "independent_evidence" | "fact_projection";
  readonly strength: number;
  /** Correlated projections share this key and cannot claim independent support. */
  readonly independence_key: string;
  readonly evidence_object_id: string | null;
  readonly document_identity: string | null;
  readonly projection: Readonly<RecallEvidenceSemanticProjectionReceipt> | null;
  readonly demand_roles: readonly CoverageDemandRole[];
  readonly observation_channels: readonly CoverageObservationChannel[];
  /** Present when an FTS observation binds this atom to concrete retrieval lanes. */
  readonly matched_fts_lanes?: readonly FtsLaneId[];
}>;

export type CandidateCoverageReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof COVERAGE_ATOM_OPERATOR_ID;
  readonly candidate_key: string;
  readonly activation: CandidateActivationReceipt;
  readonly evidence_semantic_completeness:
    | RecallEvidenceSemanticActivationReceipt["observation_completeness"]
    | "not_observed";
  readonly projection_match_count: number;
  readonly atoms: readonly CandidateCoverageAtom[];
}>;

type CoverageAtomCandidate = Readonly<RecallCandidateActivationInput & {
  readonly entry: Readonly<{
    readonly object_id: string;
    readonly object_kind?: "memory_entry" | "synthesis_capsule" | "evidence_capsule";
    readonly evidence_refs: readonly string[];
  }>;
  readonly fusion: Readonly<{ readonly candidate_key: string }>;
}>;

type CandidateCoverageSupplementary = RecallCandidateActivationSupplementary &
  Readonly<Pick<RecallSupplementaryData, "evidenceProjectionMatchesByRef">>;

type CoverageAtomObservation = Readonly<{
  readonly channel: CoverageObservationChannel;
  readonly score: number;
  readonly evidenceObjectId: string;
  readonly documentIdentity: string;
  readonly projection: Readonly<RecallEvidenceSemanticProjectionReceipt> | null;
  readonly matchedFtsLanes: readonly FtsLaneId[];
}>;

export function resolveCandidateCoverageReceipt(
  candidate: CoverageAtomCandidate,
  supplementaryData: CandidateCoverageSupplementary
): CandidateCoverageReceipt {
  const activation = resolveRecallCandidateSemanticActivation(
    candidate,
    supplementaryData
  );
  return materializeCandidateCoverageReceipt({
    candidate,
    activation,
    evidenceSemanticActivation: supplementaryData
      .evidenceSemanticActivationsByCandidateKey.get(candidate.fusion.candidate_key) ?? null,
    evidenceProjectionMatches: candidateProjectionMatches(candidate, supplementaryData)
  });
}

export function materializeCandidateCoverageReceipt(params: Readonly<{
  readonly candidate: CoverageAtomCandidate;
  readonly activation: CandidateActivationReceipt;
  readonly evidenceSemanticActivation:
    | Readonly<RecallEvidenceSemanticActivationReceipt>
    | null;
  readonly evidenceProjectionMatches:
    readonly Readonly<RecallEvidenceProjectionMatchReceipt>[];
}>): CandidateCoverageReceipt {
  const objectAtom = logicalObjectAtom(params.candidate);
  const observations = coverageAtomObservations(
    params.evidenceSemanticActivation,
    params.evidenceProjectionMatches
  );
  return Object.freeze({
    schema_version: 1,
    operator_id: COVERAGE_ATOM_OPERATOR_ID,
    candidate_key: params.candidate.fusion.candidate_key,
    activation: params.activation,
    evidence_semantic_completeness:
      params.evidenceSemanticActivation?.observation_completeness ?? "not_observed",
    projection_match_count: params.evidenceProjectionMatches.length,
    atoms: Object.freeze([objectAtom, ...materializeCoverageAtoms(observations)])
  });
}

function logicalObjectAtom(candidate: CoverageAtomCandidate): CandidateCoverageAtom {
  const objectKey = buildRecallLogicalObjectKey(candidate);
  return freezeAtom({
    atom_id: `object:${objectKey}`,
    kind: "logical_object",
    strength: 1,
    independence_key: `object:${objectKey}`,
    evidence_object_id: null,
    document_identity: null,
    projection: null,
    demand_roles: Object.freeze([]),
    observation_channels: Object.freeze([])
  });
}

function materializeCoverageAtoms(
  observations: readonly CoverageAtomObservation[]
): readonly CandidateCoverageAtom[] {
  const evidence = new Map<string, CandidateCoverageAtom>();
  const projections = new Map<string, CandidateCoverageAtom>();
  for (const observation of observations) {
    upsertEvidenceAtom(evidence, observation);
    if (isValidFactProjection(observation.projection)) {
      upsertProjectionAtom(projections, observation);
    }
  }
  return Object.freeze([
    ...[...evidence.values()].sort(compareAtoms),
    ...[...projections.values()].sort(compareAtoms)
  ]);
}

function upsertEvidenceAtom(
  atoms: Map<string, CandidateCoverageAtom>,
  observation: CoverageAtomObservation
): void {
  const independenceKey = `evidence:${observation.evidenceObjectId}`;
  const current = atoms.get(independenceKey);
  atoms.set(independenceKey, freezeAtom({
    atom_id: independenceKey,
    kind: "independent_evidence",
    strength: Math.max(current?.strength ?? 0, clamp01(observation.score)),
    independence_key: independenceKey,
    evidence_object_id: observation.evidenceObjectId,
    document_identity: null,
    projection: null,
    demand_roles: Object.freeze([]),
    observation_channels: mergeObservationChannels(
      current?.observation_channels ?? [],
      observation.channel
    ),
    ...ftsLaneProperty(mergeFtsLaneIds(
      current?.matched_fts_lanes ?? [],
      observation.matchedFtsLanes
    ))
  }));
}

function upsertProjectionAtom(
  atoms: Map<string, CandidateCoverageAtom>,
  observation: CoverageAtomObservation
): void {
  const projection = observation.projection!;
  const atomId = `fact:${observation.evidenceObjectId}:${String(projection.projection_id)}`;
  const current = atoms.get(atomId);
  const strength = clamp01(observation.score);
  const mergedProjection = mergeFactProjection(current?.projection, projection);
  const demandRoles = mergeDemandRoles(current?.demand_roles ?? [], mergedProjection);
  const provenance = current === undefined || prefersObservation(
    observation,
    strength,
    current
  )
    ? { documentIdentity: observation.documentIdentity, projection }
    : { documentIdentity: current.document_identity, projection: current.projection! };
  atoms.set(atomId, freezeAtom({
    atom_id: atomId,
    kind: "fact_projection",
    strength: Math.max(current?.strength ?? 0, strength),
    independence_key: `evidence:${observation.evidenceObjectId}`,
    evidence_object_id: observation.evidenceObjectId,
    document_identity: provenance.documentIdentity,
    projection: mergedProjection,
    demand_roles: demandRoles,
    observation_channels: mergeObservationChannels(
      current?.observation_channels ?? [],
      observation.channel
    ),
    ...ftsLaneProperty(mergeFtsLaneIds(
      current?.matched_fts_lanes ?? [],
      observation.matchedFtsLanes
    ))
  }));
}

function prefersObservation(
  observation: CoverageAtomObservation,
  strength: number,
  current: CandidateCoverageAtom
): boolean {
  if (strength !== current.strength) return strength > current.strength;
  return compareText(observation.documentIdentity, current.document_identity ?? "") < 0;
}

function coverageAtomObservations(
  semantic: Readonly<RecallEvidenceSemanticActivationReceipt> | null,
  projectionMatches: readonly Readonly<RecallEvidenceProjectionMatchReceipt>[]
): readonly CoverageAtomObservation[] {
  return Object.freeze([
    ...(semantic?.observations ?? []).map(semanticObservation),
    ...projectionMatches.map(projectionMatchObservation)
  ]);
}

function semanticObservation(
  observation: Readonly<RecallEvidenceSemanticWinnerReceipt>
): CoverageAtomObservation {
  return Object.freeze({
    ...observation,
    channel: "evidence_semantic",
    matchedFtsLanes: Object.freeze([])
  });
}

function projectionMatchObservation(
  match: Readonly<RecallEvidenceProjectionMatchReceipt>
): CoverageAtomObservation {
  const factKey = match.projection_kind === "fact_key" &&
    Number.isInteger(match.projection_id) && (match.projection_id as number) > 0;
  const projection = factKey ? Object.freeze({
      projection_id: match.projection_id,
      projection_kind: "fact_key" as const,
      matched_fact_key_forms: match.fact_key_forms,
      ...(match.fact_slots === undefined ? {} : {
        fact_slots: Object.freeze(match.fact_slots.map((slot) => Object.freeze({ ...slot })))
      })
    }) : null;
  return Object.freeze({
    channel: "evidence_fts",
    score: clamp01(match.normalized_rank),
    evidenceObjectId: match.evidence_ref,
    documentIdentity: factKey ? `fact_key:${String(match.projection_id)}` : "owner",
    projection,
    matchedFtsLanes: Object.freeze([...(match.matched_fts_lanes ?? [])])
  });
}

function ftsLaneProperty(lanes: readonly FtsLaneId[]): Readonly<{
  readonly matched_fts_lanes?: readonly FtsLaneId[];
}> {
  return lanes.length === 0 ? Object.freeze({}) : Object.freeze({
    matched_fts_lanes: lanes
  });
}

function isValidFactProjection(
  projection: Readonly<RecallEvidenceSemanticProjectionReceipt> | null
): boolean {
  return projection?.projection_kind === "fact_key" &&
    Number.isInteger(projection.projection_id) &&
    (projection.projection_id as number) > 0;
}

function candidateProjectionMatches(
  candidate: CoverageAtomCandidate,
  supplementaryData: CandidateCoverageSupplementary
): readonly Readonly<RecallEvidenceProjectionMatchReceipt>[] {
  const evidenceRefs = new Set(candidate.entry.evidence_refs);
  if (candidate.objectKind === "evidence_capsule") {
    evidenceRefs.add(candidate.entry.object_id);
  }
  return Object.freeze([...evidenceRefs].flatMap((evidenceRef) =>
    supplementaryData.evidenceProjectionMatchesByRef[evidenceRef] ?? []
  ));
}

function mergeObservationChannels(
  current: readonly CoverageObservationChannel[],
  channel: CoverageObservationChannel
): readonly CoverageObservationChannel[] {
  return Object.freeze([...new Set([...current, channel])].sort(compareText));
}

function mergeDemandRoles(
  current: readonly CoverageDemandRole[],
  projection: Readonly<RecallEvidenceSemanticProjectionReceipt>
): readonly CoverageDemandRole[] {
  const roles = new Set<CoverageDemandRole>(current);
  for (const form of projection.matched_fact_key_forms) {
    roles.add(form.kind === "complete" ? "complete" : form.omitted_slot.role);
  }
  return Object.freeze([...roles].sort(compareDemandRoles));
}

function mergeFactProjection(
  current: Readonly<RecallEvidenceSemanticProjectionReceipt> | null | undefined,
  observed: Readonly<RecallEvidenceSemanticProjectionReceipt>
): Readonly<RecallEvidenceSemanticProjectionReceipt> {
  if (current === null || current === undefined) return observed;
  if (current.projection_id !== observed.projection_id ||
      current.projection_kind !== observed.projection_kind) {
    throw new Error("coverage fact projection identity mismatch");
  }
  const factSlots = mergeFactSlots(current.fact_slots, observed.fact_slots);
  const forms = new Map([
    ...current.matched_fact_key_forms,
    ...observed.matched_fact_key_forms
  ].map((form) => [buildCoverageProjectionFormKey(form), form]));
  return Object.freeze({
    projection_id: current.projection_id,
    projection_kind: current.projection_kind,
    matched_fact_key_forms: Object.freeze([...forms]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, form]) => form)),
    ...(factSlots === undefined ? {} : { fact_slots: factSlots })
  });
}

function mergeFactSlots(
  current: RecallEvidenceSemanticProjectionReceipt["fact_slots"],
  observed: RecallEvidenceSemanticProjectionReceipt["fact_slots"]
): RecallEvidenceSemanticProjectionReceipt["fact_slots"] {
  if (current === undefined || current.length === 0) return observed;
  if (observed === undefined || observed.length === 0) return current;
  const same = current.length === observed.length && current.every((slot, index) =>
    slot.role === observed[index]?.role && slot.text === observed[index]?.text
  );
  if (!same) throw new Error("coverage fact slot provenance mismatch");
  return current;
}

function compareDemandRoles(left: CoverageDemandRole, right: CoverageDemandRole): number {
  return DEMAND_ROLE_ORDER.indexOf(left) - DEMAND_ROLE_ORDER.indexOf(right);
}

function compareAtoms(left: CandidateCoverageAtom, right: CandidateCoverageAtom): number {
  return compareText(left.atom_id, right.atom_id);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function freezeAtom(atom: CandidateCoverageAtom): CandidateCoverageAtom {
  return Object.freeze(atom);
}

const DEMAND_ROLE_ORDER: readonly CoverageDemandRole[] = [
  "subject",
  "relation",
  "value",
  "qualifier",
  "time",
  "complete"
];
