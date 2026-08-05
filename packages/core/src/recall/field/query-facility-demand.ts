import type {
  RecallQueryDemand,
  RecallQueryDemandAtom
} from "../query/recall-query-demand.js";
import type {
  FacilityDemandAtom,
  FacilityDemandKind
} from "./facility-objective.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "./field-identity.js";
import {
  normalizeRecallQueryDemand,
  normalizeRecallQueryFieldAttributions,
  verifyRecallQueryFieldAttributionReceipt,
  type RecallQueryFieldAttribution,
  type ReplayableRecallQueryFieldAttributionReceipt
} from "./query-attribution/query-field-attribution.js";

export const ATTRIBUTED_QUERY_FACILITY_DEMAND_OPERATOR_ID =
  "attributed_query_facility_demand_v1";

export type AttributedQueryFacilityDemandAtom = FacilityDemandAtom & Readonly<{
  readonly value: string;
  readonly source_query_atom_id: string;
  readonly attribution_kind: "typed_query_atom" | "explicit_field_role";
}>;

export type AttributedQueryFacilityDemandReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof ATTRIBUTED_QUERY_FACILITY_DEMAND_OPERATOR_ID;
  readonly query_demand_digest: RecallFieldDigest;
  readonly field_attribution_digest: RecallFieldDigest | null;
  readonly weight_configuration_digest: RecallFieldDigest;
  readonly demand_atoms: readonly Readonly<AttributedQueryFacilityDemandAtom>[];
  readonly demand_digest: RecallFieldDigest;
}>;

export type FacilityDemandWeights = Readonly<Record<FacilityDemandKind, number>>;

export function materializeAttributedQueryFacilityDemand(params: Readonly<{
  readonly query_demand: Readonly<RecallQueryDemand>;
  readonly weights: FacilityDemandWeights;
  readonly field_attribution?:
    Readonly<ReplayableRecallQueryFieldAttributionReceipt>;
}>): AttributedQueryFacilityDemandReceipt {
  const query = normalizeRecallQueryDemand(params.query_demand);
  const weights = normalizeWeights(params.weights);
  const attribution = params.field_attribution;
  let explicitAttributions: readonly Readonly<RecallQueryFieldAttribution>[] = [];
  if (attribution !== undefined) {
    verifyRecallQueryFieldAttributionReceipt(attribution);
    if (attribution.query_demand_digest !== query.digest) {
      throw new Error("query field attribution query digest mismatch");
    }
    explicitAttributions = normalizeRecallQueryFieldAttributions(
      attribution.attributions,
      query.atomsById
    );
  }
  const demandAtoms = materializeDemandAtoms(
    query.atomsById,
    weights,
    explicitAttributions
  );
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: ATTRIBUTED_QUERY_FACILITY_DEMAND_OPERATOR_ID,
    query_demand_digest: query.digest,
    field_attribution_digest: attribution?.attribution_digest ?? null,
    weight_configuration_digest: digestRecallFieldIdentity(weights),
    demand_atoms: demandAtoms
  });
  return Object.freeze({ ...body, demand_digest: digestRecallFieldIdentity(body) });
}

export function verifyAttributedQueryFacilityDemand(
  receipt: Readonly<AttributedQueryFacilityDemandReceipt>
): void {
  if (receipt.schema_version !== 1 ||
      receipt.operator_id !== ATTRIBUTED_QUERY_FACILITY_DEMAND_OPERATOR_ID) {
    throw new Error("attributed query facility demand schema or operator mismatch");
  }
  assertSha256(receipt.query_demand_digest, "query demand digest");
  assertSha256(receipt.weight_configuration_digest, "weight configuration digest");
  if (receipt.field_attribution_digest !== null) {
    assertSha256(receipt.field_attribution_digest, "field attribution digest");
  }
  validateDemandAtoms(receipt.demand_atoms);
  const { demand_digest: _digest, ...body } = receipt;
  if (digestRecallFieldIdentity(body) !== receipt.demand_digest) {
    throw new Error("attributed query facility demand digest mismatch");
  }
}

function materializeDemandAtoms(
  queryAtoms: ReadonlyMap<string, Readonly<RecallQueryDemandAtom>>,
  weights: FacilityDemandWeights,
  attributions: readonly Readonly<RecallQueryFieldAttribution>[]
): readonly Readonly<AttributedQueryFacilityDemandAtom>[] {
  const atoms = [...queryAtoms.values()].flatMap((atom) => {
    const kind = TYPED_DEMAND_KINDS.get(atom.kind);
    return kind === undefined
      ? []
      : [facilityDemandAtom(atom, kind, weights, "typed_query_atom")];
  });
  for (const field of attributions) {
    atoms.push(facilityDemandAtom(
      queryAtoms.get(field.query_atom_id)!,
      field.role,
      weights,
      "explicit_field_role"
    ));
  }
  return Object.freeze(atoms.sort(compareDemandAtoms));
}

function facilityDemandAtom(
  source: Readonly<RecallQueryDemandAtom>,
  kind: FacilityDemandKind,
  weights: FacilityDemandWeights,
  attributionKind: AttributedQueryFacilityDemandAtom["attribution_kind"]
): Readonly<AttributedQueryFacilityDemandAtom> {
  return Object.freeze({
    demand_atom_id: `facility:${kind}:${source.id}`,
    kind,
    weight: weights[kind],
    value: source.value,
    source_query_atom_id: source.id,
    attribution_kind: attributionKind
  });
}

function normalizeWeights(weights: FacilityDemandWeights): FacilityDemandWeights {
  if (Object.keys(weights).length !== FACILITY_DEMAND_KINDS.length) {
    throw new Error("facility demand weights must cover the fixed kind catalog");
  }
  return Object.freeze(Object.fromEntries(FACILITY_DEMAND_KINDS.map((kind) => {
    const weight = weights[kind];
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error("facility demand weight must be finite and non-negative");
    }
    return [kind, weight];
  }))) as FacilityDemandWeights;
}

function validateDemandAtoms(
  atoms: readonly Readonly<AttributedQueryFacilityDemandAtom>[]
): void {
  const ids = new Set<string>();
  for (const atom of atoms) {
    assertIdentity(atom.demand_atom_id, "facility demand atom id");
    assertIdentity(atom.value, "facility demand value");
    assertIdentity(atom.source_query_atom_id, "facility source query atom id");
    if (!FACILITY_DEMAND_KIND_SET.has(atom.kind) ||
        !ATTRIBUTION_KINDS.has(atom.attribution_kind) ||
        !Number.isFinite(atom.weight) || atom.weight < 0 || ids.has(atom.demand_atom_id)) {
      throw new Error("attributed facility demand atom is invalid");
    }
    ids.add(atom.demand_atom_id);
  }
}

function assertIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}

function compareDemandAtoms(
  left: Readonly<AttributedQueryFacilityDemandAtom>,
  right: Readonly<AttributedQueryFacilityDemandAtom>
): number {
  const sourceOrder = compareText(left.source_query_atom_id, right.source_query_atom_id);
  return sourceOrder === 0 ? compareText(left.kind, right.kind) : sourceOrder;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

const TYPED_DEMAND_KINDS: ReadonlyMap<RecallQueryDemandAtom["kind"], FacilityDemandKind> =
  new Map([
    ["temporal", "time"],
    ["object_id", "logical_object"],
    ["evidence_ref", "independent_evidence"]
  ]);
const FACILITY_DEMAND_KINDS = Object.freeze([
  "entity", "relation", "time", "logical_object", "independent_evidence"
] as const);
const FACILITY_DEMAND_KIND_SET: ReadonlySet<string> = new Set(FACILITY_DEMAND_KINDS);
const ATTRIBUTION_KINDS: ReadonlySet<string> = new Set([
  "typed_query_atom", "explicit_field_role"
]);
