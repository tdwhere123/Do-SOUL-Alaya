export const SELECTED_SLICE_KEY_SCHEMA_VERSION = 1 as const;

export const SELECTED_SLICE_KEY_V1_SEED_DIMENSIONS = Object.freeze([
  "time",
  "space",
  "entity",
  "semantic"
] as const);

export const SELECTED_SLICE_KEY_V1_PROVENANCE_KINDS = Object.freeze([
  "event_time",
  "time_concern",
  "location_facet",
  "canonical_entity",
  "object_anchor",
  "path_facet",
  "facet_tag",
  "query_probe"
] as const);

export type SelectedSliceKeySeedDimensionV1 =
  (typeof SELECTED_SLICE_KEY_V1_SEED_DIMENSIONS)[number];

/** Extensible routing metadata; never ontology truth. */
export type SelectedSliceKeyDimensionV1 =
  | SelectedSliceKeySeedDimensionV1
  | (string & {});

export type SelectedSliceKeyProvenanceKindV1 =
  (typeof SELECTED_SLICE_KEY_V1_PROVENANCE_KINDS)[number];

export type SelectedSliceKeyFreshnessV1 = Readonly<{
  state: "fresh" | "stale";
  as_of_ms: number;
}>;

export type SelectedSliceKeyProvenanceV1 = Readonly<{
  kind: SelectedSliceKeyProvenanceKindV1;
  source_ref: string;
}>;

export type SelectedSliceKeyInputV1 = Readonly<{
  workspace_id: string;
  dimension: SelectedSliceKeyDimensionV1;
  value: string;
  provenance: SelectedSliceKeyProvenanceV1;
  source_version: string;
  freshness: SelectedSliceKeyFreshnessV1;
}>;

export interface SelectedSliceKeyV1 {
  readonly schema_version: typeof SELECTED_SLICE_KEY_SCHEMA_VERSION;
  readonly key_id: string;
  readonly match_id: string;
  readonly workspace_id: string;
  readonly dimension: SelectedSliceKeyDimensionV1;
  readonly normalized_value: string;
  readonly provenance: SelectedSliceKeyProvenanceV1;
  readonly source_version: string;
  readonly freshness: SelectedSliceKeyFreshnessV1;
}

export interface SelectedSliceKeyMatchV1 {
  readonly match_id: string;
  readonly query_keys: readonly SelectedSliceKeyV1[];
  readonly source_keys: readonly SelectedSliceKeyV1[];
  readonly target_keys: readonly SelectedSliceKeyV1[];
}

const provenanceKinds = new Set<string>(SELECTED_SLICE_KEY_V1_PROVENANCE_KINDS);
const dimensionsByProvenance: Readonly<
  Record<SelectedSliceKeyProvenanceKindV1, readonly string[] | null>
> = Object.freeze({
  event_time: Object.freeze(["time"]),
  time_concern: Object.freeze(["time"]),
  location_facet: Object.freeze(["space"]),
  canonical_entity: Object.freeze(["entity", "space"]),
  object_anchor: Object.freeze(["object", "entity"]),
  path_facet: Object.freeze(["semantic"]),
  facet_tag: Object.freeze(["semantic"]),
  query_probe: null
});

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

function normalizeFreshness(freshness: SelectedSliceKeyFreshnessV1): SelectedSliceKeyFreshnessV1 {
  if (freshness.state !== "fresh" && freshness.state !== "stale") {
    throw new Error("freshness.state must be fresh or stale");
  }
  if (!Number.isSafeInteger(freshness.as_of_ms) || freshness.as_of_ms < 0) {
    throw new Error("freshness.as_of_ms must be a non-negative safe integer");
  }
  return Object.freeze({ state: freshness.state, as_of_ms: freshness.as_of_ms });
}

function normalizeProvenance(
  provenance: SelectedSliceKeyProvenanceV1
): SelectedSliceKeyProvenanceV1 {
  if (!provenanceKinds.has(provenance.kind)) {
    throw new Error("provenance.kind is not supported by SelectedSliceKeyV1");
  }
  return Object.freeze({
    kind: provenance.kind,
    source_ref: normalizeOpaqueField(provenance.source_ref, "provenance.source_ref")
  });
}

function validateProvenanceDimension(
  provenanceKind: SelectedSliceKeyProvenanceKindV1,
  dimension: string
): void {
  const allowed = dimensionsByProvenance[provenanceKind];
  if (allowed !== null && !allowed.includes(dimension)) {
    throw new Error(`${provenanceKind} provenance requires ${allowed.join(" or ")} dimension`);
  }
}

export function createSelectedSliceKeyV1(input: SelectedSliceKeyInputV1): SelectedSliceKeyV1 {
  const workspaceId = normalizeOpaqueField(input.workspace_id, "workspace_id");
  const dimension = normalizeRoutingToken(input.dimension, "dimension");
  const normalizedValue = normalizeRoutingToken(input.value, "value");
  const provenance = normalizeProvenance(input.provenance);
  validateProvenanceDimension(provenance.kind, dimension);
  const sourceVersion = normalizeOpaqueField(input.source_version, "source_version");
  const freshness = normalizeFreshness(input.freshness);
  const matchId = JSON.stringify([workspaceId, dimension, normalizedValue]);
  const keyId = JSON.stringify([
    SELECTED_SLICE_KEY_SCHEMA_VERSION,
    workspaceId,
    dimension,
    normalizedValue,
    provenance.kind,
    provenance.source_ref,
    sourceVersion
  ]);
  return Object.freeze({
    schema_version: SELECTED_SLICE_KEY_SCHEMA_VERSION,
    key_id: keyId,
    match_id: matchId,
    workspace_id: workspaceId,
    dimension,
    normalized_value: normalizedValue,
    provenance,
    source_version: sourceVersion,
    freshness
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortUniqueSelectedKeys(
  keys: readonly SelectedSliceKeyV1[]
): readonly SelectedSliceKeyV1[] {
  const byKeyId = new Map<string, SelectedSliceKeyV1>();
  for (const key of keys) {
    const current = byKeyId.get(key.key_id);
    byKeyId.set(key.key_id, current === undefined ? key : preferFreshness(current, key));
  }
  return Object.freeze([...byKeyId.values()].sort((left, right) =>
    compareText(left.key_id, right.key_id)
  ));
}

function preferFreshness(
  left: SelectedSliceKeyV1,
  right: SelectedSliceKeyV1
): SelectedSliceKeyV1 {
  const delta = right.freshness.as_of_ms - left.freshness.as_of_ms;
  if (delta !== 0) return delta > 0 ? right : left;
  if (left.freshness.state === right.freshness.state) return left;
  return left.freshness.state === "fresh" ? left : right;
}

export function normalizeSelectedSliceKeysV1(
  inputs: readonly SelectedSliceKeyInputV1[]
): readonly SelectedSliceKeyV1[] {
  return sortUniqueSelectedKeys(inputs.map(createSelectedSliceKeyV1));
}

function groupKeysByMatchId(
  keys: readonly SelectedSliceKeyV1[]
): ReadonlyMap<string, readonly SelectedSliceKeyV1[]> {
  const groups = new Map<string, SelectedSliceKeyV1[]>();
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

export function intersectSelectedSliceKeysV1(
  queryKeys: readonly SelectedSliceKeyV1[],
  sourceKeys: readonly SelectedSliceKeyV1[],
  targetKeys: readonly SelectedSliceKeyV1[]
): readonly Readonly<SelectedSliceKeyMatchV1>[] {
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
