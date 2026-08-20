import type {
  RecallQueryDemand,
  RecallQueryDemandAtom
} from "../../query/recall-query-demand.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../field-identity.js";
import { compareText } from "../../../shared/compare-text.js";

export const QUERY_FIELD_ATTRIBUTION_RECEIPT_OPERATOR_ID =
  "query_field_attribution_receipt_v2";
export const QUERY_FIELD_ATTRIBUTION_CONTRIBUTION_OPERATOR_ID =
  "query_field_attribution_contribution_v1";
const LEGACY_QUERY_FIELD_ATTRIBUTION_RECEIPT_OPERATOR_ID =
  "query_field_attribution_receipt_v1";

export type RecallQueryFieldRole = "entity" | "relation";
export type RecallQueryFieldAttribution = Readonly<{
  readonly query_atom_id: string;
  readonly role: RecallQueryFieldRole;
}>;
export type RecallQueryFieldAttributionContributionItem =
  RecallQueryFieldAttribution & Readonly<{
    readonly source_spans: readonly (readonly [number, number])[];
  }>;

export type RecallQueryFieldAttributionContribution = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_FIELD_ATTRIBUTION_CONTRIBUTION_OPERATOR_ID;
  readonly producer_operator_id: string;
  readonly producer_capture_digest: RecallFieldDigest;
  readonly query_demand_digest: RecallFieldDigest;
  readonly attributions:
    readonly Readonly<RecallQueryFieldAttributionContributionItem>[];
  readonly contribution_digest: RecallFieldDigest;
}>;

export type RecallQueryFieldAttributionReceipt = Readonly<{
  readonly schema_version: 2;
  readonly operator_id: typeof QUERY_FIELD_ATTRIBUTION_RECEIPT_OPERATOR_ID;
  readonly query_demand_digest: RecallFieldDigest;
  readonly contributions:
    readonly Readonly<RecallQueryFieldAttributionContribution>[];
  readonly attributions: readonly Readonly<RecallQueryFieldAttribution>[];
  readonly attribution_digest: RecallFieldDigest;
}>;

type LegacyRecallQueryFieldAttributionReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof LEGACY_QUERY_FIELD_ATTRIBUTION_RECEIPT_OPERATOR_ID;
  readonly producer_operator_id: string;
  readonly producer_capture_digest: RecallFieldDigest;
  readonly query_demand_digest: RecallFieldDigest;
  readonly attributions: readonly Readonly<RecallQueryFieldAttribution>[];
  readonly attribution_digest: RecallFieldDigest;
}>;

export type ReplayableRecallQueryFieldAttributionReceipt =
  | RecallQueryFieldAttributionReceipt
  | LegacyRecallQueryFieldAttributionReceipt;

export type NormalizedRecallQueryDemand = Readonly<{
  readonly digest: RecallFieldDigest;
  readonly atomsById: ReadonlyMap<string, Readonly<RecallQueryDemandAtom>>;
}>;

export function createRecallQueryFieldAttributionReceipt(params: Readonly<{
  readonly producer_operator_id: string;
  readonly producer_capture_digest: RecallFieldDigest;
  readonly query_demand: Readonly<RecallQueryDemand>;
  readonly attributions:
    readonly Readonly<RecallQueryFieldAttributionContributionItem>[];
}>): RecallQueryFieldAttributionReceipt {
  return aggregateRecallQueryFieldAttributionContributions({
    query_demand: params.query_demand,
    contributions: [createRecallQueryFieldAttributionContribution(params)]
  });
}

export function createRecallQueryFieldAttributionContribution(params: Readonly<{
  readonly producer_operator_id: string;
  readonly producer_capture_digest: RecallFieldDigest;
  readonly query_demand: Readonly<RecallQueryDemand>;
  readonly attributions:
    readonly Readonly<RecallQueryFieldAttributionContributionItem>[];
}>): RecallQueryFieldAttributionContribution {
  assertIdentity(params.producer_operator_id, "query field attribution producer");
  assertSha256(params.producer_capture_digest, "query field attribution producer capture");
  const query = normalizeRecallQueryDemand(params.query_demand);
  const attributions = normalizeContributionAttributions(
    params.attributions,
    query.atomsById
  );
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_FIELD_ATTRIBUTION_CONTRIBUTION_OPERATOR_ID,
    producer_operator_id: params.producer_operator_id,
    producer_capture_digest: params.producer_capture_digest,
    query_demand_digest: query.digest,
    attributions
  });
  return Object.freeze({
    ...body,
    contribution_digest: digestRecallFieldIdentity(body)
  });
}

export function aggregateRecallQueryFieldAttributionContributions(params: Readonly<{
  readonly query_demand: Readonly<RecallQueryDemand>;
  readonly contributions:
    readonly Readonly<RecallQueryFieldAttributionContribution>[];
}>): RecallQueryFieldAttributionReceipt {
  const query = normalizeRecallQueryDemand(params.query_demand);
  const contributions = normalizeContributions(params.contributions, query.digest);
  const attributions = mergeContributionAttributions(contributions);
  const body = Object.freeze({
    schema_version: 2 as const,
    operator_id: QUERY_FIELD_ATTRIBUTION_RECEIPT_OPERATOR_ID,
    query_demand_digest: query.digest,
    contributions,
    attributions
  });
  return Object.freeze({
    ...body,
    attribution_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyRecallQueryFieldAttributionReceipt(
  receipt: Readonly<ReplayableRecallQueryFieldAttributionReceipt>
): void {
  if (receipt.schema_version === 1) return verifyLegacyAttributionReceipt(receipt);
  if (receipt.schema_version !== 2 ||
      receipt.operator_id !== QUERY_FIELD_ATTRIBUTION_RECEIPT_OPERATOR_ID) {
    throw new Error("query field attribution schema or operator mismatch");
  }
  assertSha256(receipt.query_demand_digest, "query demand digest");
  const contributions = normalizeContributions(
    receipt.contributions,
    receipt.query_demand_digest
  );
  const attributions = mergeContributionAttributions(contributions);
  if (stableStringify(contributions) !== stableStringify(receipt.contributions) ||
      stableStringify(attributions) !== stableStringify(receipt.attributions)) {
    throw new Error("query field attribution aggregation mismatch");
  }
  const { attribution_digest: _digest, ...body } = receipt;
  if (digestRecallFieldIdentity(body) !== receipt.attribution_digest) {
    throw new Error("query field attribution digest mismatch");
  }
}

export function verifyRecallQueryFieldAttributionContribution(
  contribution: Readonly<RecallQueryFieldAttributionContribution>
): void {
  if (contribution.schema_version !== 1 ||
      contribution.operator_id !== QUERY_FIELD_ATTRIBUTION_CONTRIBUTION_OPERATOR_ID) {
    throw new Error("query field attribution contribution schema mismatch");
  }
  assertIdentity(contribution.producer_operator_id, "query field attribution producer");
  assertSha256(contribution.producer_capture_digest, "query field attribution producer capture");
  assertSha256(contribution.query_demand_digest, "query demand digest");
  normalizeContributionAttributions(contribution.attributions);
  const { contribution_digest: _digest, ...body } = contribution;
  if (digestRecallFieldIdentity(body) !== contribution.contribution_digest) {
    throw new Error("query field attribution contribution digest mismatch");
  }
}

export function normalizeRecallQueryDemand(
  demand: Readonly<RecallQueryDemand>
): NormalizedRecallQueryDemand {
  if (demand.schema_version !== 1) throw new Error("query demand schema mismatch");
  const atoms = demand.atoms.map((atom) => {
    assertIdentity(atom.id, "query demand atom id");
    assertIdentity(atom.value, "query demand atom value");
    if (!QUERY_DEMAND_KINDS.has(atom.kind) ||
        !QUERY_DEMAND_PRIORITIES.has(atom.priority)) {
      throw new Error("query demand atom kind or priority is invalid");
    }
    if (atom.id !== `${atom.kind}:${atom.value}`) {
      throw new Error("query demand atom identity does not match its kind and value");
    }
    return Object.freeze({ ...atom });
  }).sort((left, right) => compareText(left.id, right.id));
  if (new Set(atoms.map(({ id }) => id)).size !== atoms.length) {
    throw new Error("query demand atom ids must be unique");
  }
  return Object.freeze({
    digest: digestRecallFieldIdentity({ schema_version: 1, atoms }),
    atomsById: new Map(atoms.map((atom) => [atom.id, atom]))
  });
}

export function normalizeRecallQueryFieldAttributions(
  values: readonly Readonly<RecallQueryFieldAttribution>[],
  queryAtoms?: ReadonlyMap<string, Readonly<RecallQueryDemandAtom>>
): readonly Readonly<RecallQueryFieldAttribution>[] {
  const output = values.map((value) => {
    validateAttribution(value, queryAtoms);
    return Object.freeze({ ...value });
  }).sort((left, right) => compareText(left.query_atom_id, right.query_atom_id));
  if (new Set(output.map(({ query_atom_id }) => query_atom_id)).size !== output.length) {
    throw new Error("query field attribution atom ids must be unique");
  }
  return Object.freeze(output);
}

function normalizeContributionAttributions(
  values: readonly Readonly<RecallQueryFieldAttributionContributionItem>[],
  queryAtoms?: ReadonlyMap<string, Readonly<RecallQueryDemandAtom>>
): readonly Readonly<RecallQueryFieldAttributionContributionItem>[] {
  const output = values.map((value) => {
    validateAttribution(value, queryAtoms);
    const sourceSpans = normalizeSourceSpans(value.source_spans);
    return Object.freeze({
      query_atom_id: value.query_atom_id,
      role: value.role,
      source_spans: sourceSpans
    });
  }).sort((left, right) => compareText(left.query_atom_id, right.query_atom_id));
  if (new Set(output.map(({ query_atom_id }) => query_atom_id)).size !== output.length) {
    throw new Error("query field contribution atom ids must be unique");
  }
  return Object.freeze(output);
}

function normalizeSourceSpans(
  values: readonly (readonly [number, number])[]
): readonly (readonly [number, number])[] {
  if (values.length === 0) throw new Error("query field contribution requires a source span");
  const spans = values.map((span) => {
    if (!Number.isSafeInteger(span[0]) || !Number.isSafeInteger(span[1]) ||
        span[0] < 0 || span[1] <= span[0]) {
      throw new Error("query field contribution source span is invalid");
    }
    return Object.freeze([span[0], span[1]] as const);
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (new Set(spans.map(([start, end]) => `${start}:${end}`)).size !== spans.length) {
    throw new Error("query field contribution source spans must be unique");
  }
  return Object.freeze(spans);
}

function normalizeContributions(
  values: readonly Readonly<RecallQueryFieldAttributionContribution>[],
  queryDigest: RecallFieldDigest
): readonly Readonly<RecallQueryFieldAttributionContribution>[] {
  const byDigest = new Map<string, Readonly<RecallQueryFieldAttributionContribution>>();
  for (const contribution of values) {
    verifyRecallQueryFieldAttributionContribution(contribution);
    if (contribution.query_demand_digest !== queryDigest) {
      throw new Error("query field attribution contribution query digest mismatch");
    }
    byDigest.set(contribution.contribution_digest, contribution);
  }
  return Object.freeze([...byDigest.values()].sort((left, right) =>
    compareText(left.contribution_digest, right.contribution_digest)
  ));
}

function mergeContributionAttributions(
  contributions: readonly Readonly<RecallQueryFieldAttributionContribution>[]
): readonly Readonly<RecallQueryFieldAttribution>[] {
  const rolesByAtom = new Map<string, Set<RecallQueryFieldRole>>();
  for (const contribution of contributions) {
    for (const attribution of contribution.attributions) {
      const roles = rolesByAtom.get(attribution.query_atom_id) ?? new Set();
      roles.add(attribution.role);
      rolesByAtom.set(attribution.query_atom_id, roles);
    }
  }
  // Fail closed at the disputed atom, not at the whole query receipt.
  return Object.freeze([...rolesByAtom].flatMap(([query_atom_id, roles]) =>
    roles.size === 1
      ? [Object.freeze({ query_atom_id, role: [...roles][0]! })]
      : []
  ).sort((left, right) => compareText(left.query_atom_id, right.query_atom_id)));
}

function verifyLegacyAttributionReceipt(
  receipt: Readonly<LegacyRecallQueryFieldAttributionReceipt>
): void {
  if (receipt.operator_id !== LEGACY_QUERY_FIELD_ATTRIBUTION_RECEIPT_OPERATOR_ID) {
    throw new Error("query field attribution schema or operator mismatch");
  }
  assertIdentity(receipt.producer_operator_id, "query field attribution producer");
  assertSha256(receipt.producer_capture_digest, "query field attribution producer capture");
  assertSha256(receipt.query_demand_digest, "query demand digest");
  normalizeRecallQueryFieldAttributions(receipt.attributions);
  const { attribution_digest: _digest, ...body } = receipt;
  if (digestRecallFieldIdentity(body) !== receipt.attribution_digest) {
    throw new Error("query field attribution digest mismatch");
  }
}

function validateAttribution(
  value: Readonly<RecallQueryFieldAttribution>,
  queryAtoms?: ReadonlyMap<string, Readonly<RecallQueryDemandAtom>>
): void {
  assertIdentity(value.query_atom_id, "query field attribution atom id");
  if (!FIELD_ROLES.has(value.role)) throw new Error("query field attribution role is invalid");
  const source = queryAtoms?.get(value.query_atom_id);
  if (queryAtoms !== undefined && source === undefined) {
    throw new Error("query field attribution must cite a query atom");
  }
  if (source !== undefined && source.kind !== "lexical_term" && source.kind !== "phrase") {
    throw new Error("query field attribution may only type lexical or phrase atoms");
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


const FIELD_ROLES: ReadonlySet<string> = new Set(["entity", "relation"]);
const QUERY_DEMAND_KINDS: ReadonlySet<string> = new Set([
  "ordering", "temporal", "lexical_term", "phrase", "object_id",
  "evidence_ref", "dimension", "scope_class", "domain_tag",
  // Historical dump atoms may still carry kind "facet"; emitters no longer mint it.
  "facet"
]);
const QUERY_DEMAND_PRIORITIES: ReadonlySet<string> = new Set(["core", "supporting"]);
