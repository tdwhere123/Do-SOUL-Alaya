import { z } from "zod";
import { compareText } from "../../shared/compare-text.js";
export const SELECTED_SLICE_KEY_SCHEMA_VERSION = 2 as const;

export const SELECTED_SLICE_KEY_V2_SEED_DIMENSIONS = Object.freeze([
  "time",
  "space",
  "entity",
  "semantic"
] as const);

export const SELECTED_SLICE_KEY_V2_PROVENANCE_KINDS = Object.freeze([
  "event_time",
  "time_concern",
  "location_facet",
  "canonical_entity",
  "object_anchor",
  "path_facet",
  "facet_tag",
  "query_probe",
  "signal_entity",
  "signal_preference",
  "signal_time",
  "signal_fact"
] as const);

export const SELECTED_SLICE_KEY_V2_AUTHORITIES = Object.freeze([
  "grounded",
  "proposed_routing_only",
  "derived_query",
  "derived_path"
] as const);

export type SelectedSliceKeySeedDimensionV2 =
  (typeof SELECTED_SLICE_KEY_V2_SEED_DIMENSIONS)[number];

/** Extensible routing metadata; never ontology truth. */
export type SelectedSliceKeyDimensionV2 =
  | SelectedSliceKeySeedDimensionV2
  | (string & {});

export type SelectedSliceKeyProvenanceKindV2 =
  (typeof SELECTED_SLICE_KEY_V2_PROVENANCE_KINDS)[number];

export type SelectedSliceKeyAuthorityV2 =
  (typeof SELECTED_SLICE_KEY_V2_AUTHORITIES)[number];

export type SelectedSliceKeyFreshnessV2 = Readonly<{
  state: "fresh" | "stale";
  as_of_ms: number;
}>;

export type SelectedSliceKeyProvenanceV2 = Readonly<{
  kind: SelectedSliceKeyProvenanceKindV2;
  source_ref: string;
}>;

export type SelectedSliceKeyInputV2 = Readonly<{
  workspace_id: string;
  owner_id: string | null;
  dimension: SelectedSliceKeyDimensionV2;
  value: string;
  authority: SelectedSliceKeyAuthorityV2;
  reliability: number | null;
  independence_group: string;
  provenance: SelectedSliceKeyProvenanceV2;
  source_version: string;
  freshness: SelectedSliceKeyFreshnessV2;
}>;

export interface SelectedSliceKeyV2 {
  readonly schema_version: typeof SELECTED_SLICE_KEY_SCHEMA_VERSION;
  readonly key_id: string;
  readonly match_id: string;
  readonly workspace_id: string;
  readonly owner_id: string | null;
  readonly dimension: SelectedSliceKeyDimensionV2;
  readonly normalized_value: string;
  readonly authority: SelectedSliceKeyAuthorityV2;
  readonly reliability: number | null;
  readonly independence_group: string;
  readonly provenance: SelectedSliceKeyProvenanceV2;
  readonly source_version: string;
  readonly freshness: SelectedSliceKeyFreshnessV2;
}

export const SelectedSliceKeyV2Schema = z.object({
  schema_version: z.literal(SELECTED_SLICE_KEY_SCHEMA_VERSION),
  key_id: z.string().min(1),
  match_id: z.string().min(1),
  workspace_id: z.string().min(1),
  owner_id: z.string().min(1).nullable(),
  dimension: z.string().min(1),
  normalized_value: z.string().min(1),
  authority: z.enum(SELECTED_SLICE_KEY_V2_AUTHORITIES),
  reliability: z.number().finite().min(0).max(1).nullable(),
  independence_group: z.string().min(1),
  provenance: z.object({
    kind: z.enum(SELECTED_SLICE_KEY_V2_PROVENANCE_KINDS),
    source_ref: z.string().min(1)
  }).strict(),
  source_version: z.string().min(1),
  freshness: z.object({
    state: z.enum(["fresh", "stale"]),
    as_of_ms: z.number().int().nonnegative()
  }).strict()
}).strict();

export interface SelectedSliceKeyMatchV2 {
  readonly match_id: string;
  readonly query_keys: readonly SelectedSliceKeyV2[];
  readonly source_keys: readonly SelectedSliceKeyV2[];
  readonly target_keys: readonly SelectedSliceKeyV2[];
}

const provenanceKinds = new Set<string>(SELECTED_SLICE_KEY_V2_PROVENANCE_KINDS);
const dimensionsByProvenance: Readonly<
  Record<SelectedSliceKeyProvenanceKindV2, readonly string[] | null>
> = Object.freeze({
  event_time: Object.freeze(["time"]),
  time_concern: Object.freeze(["time"]),
  location_facet: Object.freeze(["space"]),
  canonical_entity: Object.freeze(["entity", "space"]),
  object_anchor: Object.freeze(["object", "entity"]),
  path_facet: Object.freeze(["semantic"]),
  facet_tag: Object.freeze(["semantic"]),
  query_probe: null,
  signal_entity: Object.freeze(["entity"]),
  signal_preference: null,
  signal_time: Object.freeze(["time"]),
  signal_fact: Object.freeze(["semantic"])
});

const authorities = new Set<string>(SELECTED_SLICE_KEY_V2_AUTHORITIES);

function normalizeOpaqueField(value: string, field: string): string {
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
}

function normalizeRoutingToken(value: string, field: string): string {
  return normalizeOpaqueField(value, field).toLowerCase();
}

function normalizeOwnerId(value: string | null): string | null {
  return value === null ? null : normalizeOpaqueField(value, "owner_id");
}

function normalizeAuthority(value: SelectedSliceKeyAuthorityV2): SelectedSliceKeyAuthorityV2 {
  if (!authorities.has(value)) throw new Error("authority is not supported by SelectedSliceKeyV2");
  return value;
}

function normalizeReliability(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("reliability must be null or a finite unit value");
  }
  return value;
}

function normalizeFreshness(freshness: SelectedSliceKeyFreshnessV2): SelectedSliceKeyFreshnessV2 {
  if (freshness.state !== "fresh" && freshness.state !== "stale") {
    throw new Error("freshness.state must be fresh or stale");
  }
  if (!Number.isSafeInteger(freshness.as_of_ms) || freshness.as_of_ms < 0) {
    throw new Error("freshness.as_of_ms must be a non-negative safe integer");
  }
  return Object.freeze({ state: freshness.state, as_of_ms: freshness.as_of_ms });
}

function normalizeProvenance(
  provenance: SelectedSliceKeyProvenanceV2
): SelectedSliceKeyProvenanceV2 {
  if (!provenanceKinds.has(provenance.kind)) {
    throw new Error("provenance.kind is not supported by SelectedSliceKeyV2");
  }
  return Object.freeze({
    kind: provenance.kind,
    source_ref: normalizeOpaqueField(provenance.source_ref, "provenance.source_ref")
  });
}

function validateProvenanceDimension(
  provenanceKind: SelectedSliceKeyProvenanceKindV2,
  dimension: string
): void {
  const allowed = dimensionsByProvenance[provenanceKind];
  if (allowed !== null && !allowed.includes(dimension)) {
    throw new Error(`${provenanceKind} provenance requires ${allowed.join(" or ")} dimension`);
  }
}

export function createSelectedSliceKeyV2(input: SelectedSliceKeyInputV2): SelectedSliceKeyV2 {
  const workspaceId = normalizeOpaqueField(input.workspace_id, "workspace_id");
  const ownerId = normalizeOwnerId(input.owner_id);
  const dimension = normalizeRoutingToken(input.dimension, "dimension");
  const normalizedValue = normalizeRoutingToken(input.value, "value");
  const authority = normalizeAuthority(input.authority);
  const reliability = normalizeReliability(input.reliability);
  const independenceGroup = normalizeOpaqueField(
    input.independence_group,
    "independence_group"
  );
  const provenance = normalizeProvenance(input.provenance);
  validateProvenanceDimension(provenance.kind, dimension);
  const sourceVersion = normalizeOpaqueField(input.source_version, "source_version");
  const freshness = normalizeFreshness(input.freshness);
  const matchId = JSON.stringify([workspaceId, dimension, normalizedValue]);
  const keyId = JSON.stringify([
    SELECTED_SLICE_KEY_SCHEMA_VERSION,
    workspaceId,
    ownerId,
    dimension,
    normalizedValue,
    authority,
    reliability,
    independenceGroup,
    provenance.kind,
    provenance.source_ref,
    sourceVersion
  ]);
  return Object.freeze({
    schema_version: SELECTED_SLICE_KEY_SCHEMA_VERSION,
    key_id: keyId,
    match_id: matchId,
    workspace_id: workspaceId,
    owner_id: ownerId,
    dimension,
    normalized_value: normalizedValue,
    authority,
    reliability,
    independence_group: independenceGroup,
    provenance,
    source_version: sourceVersion,
    freshness
  });
}


export function mergeSelectedSliceKeysV2(
  left: readonly SelectedSliceKeyV2[],
  right: readonly SelectedSliceKeyV2[]
): readonly SelectedSliceKeyV2[] {
  if (right.length === 0) return left;
  if (left.length === 0) return right;
  return sortUniqueSelectedKeys([...left, ...right]);
}

function sortUniqueSelectedKeys(
  keys: readonly SelectedSliceKeyV2[]
): readonly SelectedSliceKeyV2[] {
  const byKeyId = new Map<string, SelectedSliceKeyV2>();
  for (const key of keys) {
    const current = byKeyId.get(key.key_id);
    byKeyId.set(key.key_id, current === undefined ? key : preferFreshness(current, key));
  }
  return Object.freeze([...byKeyId.values()].sort((left, right) =>
    compareText(left.key_id, right.key_id)
  ));
}

function preferFreshness(
  left: SelectedSliceKeyV2,
  right: SelectedSliceKeyV2
): SelectedSliceKeyV2 {
  const delta = right.freshness.as_of_ms - left.freshness.as_of_ms;
  if (delta !== 0) return delta > 0 ? right : left;
  if (left.freshness.state === right.freshness.state) return left;
  return left.freshness.state === "fresh" ? left : right;
}

export function normalizeSelectedSliceKeysV2(
  inputs: readonly SelectedSliceKeyInputV2[]
): readonly SelectedSliceKeyV2[] {
  return sortUniqueSelectedKeys(inputs.map(createSelectedSliceKeyV2));
}

function groupKeysByMatchId(
  keys: readonly SelectedSliceKeyV2[]
): ReadonlyMap<string, readonly SelectedSliceKeyV2[]> {
  const groups = new Map<string, SelectedSliceKeyV2[]>();
  for (const key of sortUniqueSelectedKeys(keys)) {
    const group = groups.get(key.match_id);
    if (group === undefined) {
      groups.set(key.match_id, [key]);
    } else {
      group.push(key);
    }
  }
  return groups;
}

export function intersectSelectedSliceKeysV2(
  queryKeys: readonly SelectedSliceKeyV2[],
  sourceKeys: readonly SelectedSliceKeyV2[],
  targetKeys: readonly SelectedSliceKeyV2[]
): readonly Readonly<SelectedSliceKeyMatchV2>[] {
  const queryGroups = groupKeysByMatchId(queryKeys);
  const sourceGroups = groupKeysByMatchId(sourceKeys);
  const targetGroups = groupKeysByMatchId(targetKeys);
  const commonMatchIds = [...queryGroups.keys()]
    .filter((matchId) => sourceGroups.has(matchId) && targetGroups.has(matchId))
    .sort(compareText);
  return Object.freeze(commonMatchIds.map((matchId) => Object.freeze({
    match_id: matchId,
    query_keys: Object.freeze([...(queryGroups.get(matchId) ?? [])]),
    source_keys: Object.freeze([...(sourceGroups.get(matchId) ?? [])]),
    target_keys: Object.freeze([...(targetGroups.get(matchId) ?? [])])
  })));
}
