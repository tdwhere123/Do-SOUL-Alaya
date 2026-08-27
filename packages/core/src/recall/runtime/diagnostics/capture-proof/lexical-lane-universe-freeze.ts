import { createHash } from "node:crypto";
import { compareCodeUnits, type StorageTier } from "@do-soul/alaya-protocol";
import {
  LEXICAL_LANE_INDEX_KIND,
  LEXICAL_LANE_UNIVERSE_PRODUCER_ID,
  type LexicalBoundLaneCapture,
  type LexicalBoundLaneId,
  type LexicalBoundProducerReceipt,
  type LexicalLaneEvaluatedUniverseWitness,
  type LexicalLaneIndexKind,
  type LexicalLaneUniverseApplicability,
  type LexicalLaneUniverseScope
} from "../../recall-search-port-types.js";

export function freezeLaneUniverse(
  value: unknown,
  laneId: LexicalBoundLaneId
): LexicalLaneEvaluatedUniverseWitness | undefined {
  if (value === undefined) return undefined;
  return freezePresentUniverse(value, laneId);
}

export function assertReceiptUniverseSet(
  lanes: readonly LexicalBoundLaneCapture[]
): void {
  const present = lanes.map((lane) => lane.evaluated_universe);
  const count = present.filter((universe) => universe !== undefined).length;
  if (count === 0) return;
  if (count !== lanes.length) {
    throw new TypeError("lexical lane universe set is incomplete");
  }
  assertSharedRequestAxes(present as readonly LexicalLaneEvaluatedUniverseWitness[]);
  assertEffectiveAppliedTiers(present as readonly LexicalLaneEvaluatedUniverseWitness[]);
  for (const lane of lanes) {
    assertObservedRowsInUniverse(lane);
  }
}

export function assertUniversesMatchIdentity(
  receipt: LexicalBoundProducerReceipt,
  workspaceId: string | undefined
): void {
  if (workspaceId === undefined) return;
  for (const lane of receipt.lanes) {
    const universe = lane.evaluated_universe;
    if (universe !== undefined && universe.scope.workspace_id !== workspaceId) {
      throw new TypeError("lexical lane universe workspace does not match sealed identity");
    }
  }
}

function freezePresentUniverse(
  value: unknown,
  laneId: LexicalBoundLaneId
): LexicalLaneEvaluatedUniverseWitness {
  if (!isRecord(value) || value.producer_id !== LEXICAL_LANE_UNIVERSE_PRODUCER_ID ||
      value.lane_id !== laneId || !isIndexKind(value.index_kind) ||
      LEXICAL_LANE_INDEX_KIND[laneId] !== value.index_kind ||
      typeof value.tokens_routed !== "boolean" ||
      !Array.isArray(value.candidate_keys) || !isDenseArray(value.candidate_keys) ||
      !Number.isInteger(value.count) || Number(value.count) < 0) {
    throw new TypeError("lexical lane universe witness is invalid");
  }
  const candidateKeys = freezeSortedUniqueKeys(value.candidate_keys);
  const applicability = freezeApplicability(value.applicability, value.tokens_routed);
  assertRoutedKeys(value.tokens_routed, applicability, candidateKeys, Number(value.count));
  const body = Object.freeze({
    producer_id: LEXICAL_LANE_UNIVERSE_PRODUCER_ID,
    lane_id: laneId,
    index_kind: value.index_kind,
    tokens_routed: value.tokens_routed,
    applicability,
    scope: freezeScope(value.scope),
    candidate_keys: candidateKeys,
    count: Number(value.count)
  });
  const digest = digestUniverse(body);
  if (value.universe_digest !== digest) {
    throw new TypeError("lexical lane universe digest mismatch");
  }
  return Object.freeze({ ...body, universe_digest: digest });
}

function freezeApplicability(
  value: unknown,
  tokensRouted: boolean
): LexicalLaneUniverseApplicability {
  if (!isRecord(value) || typeof value.applicable !== "boolean" ||
      value.applicable !== tokensRouted) {
    throw new TypeError("lexical lane universe applicability does not match routed tokens");
  }
  if (value.applicable === true) {
    if (value.reason !== undefined) {
      throw new TypeError("lexical lane universe applicability is invalid");
    }
    return Object.freeze({ applicable: true as const });
  }
  if (value.reason !== "no_tokens_routed") {
    throw new TypeError("lexical lane universe applicability is invalid");
  }
  return Object.freeze({ applicable: false as const, reason: "no_tokens_routed" as const });
}

function freezeScope(value: unknown): LexicalLaneUniverseScope {
  if (!isRecord(value) || typeof value.workspace_id !== "string" ||
      value.workspace_id.trim().length === 0 ||
      (value.tier !== null && !isStorageTier(value.tier))) {
    throw new TypeError("lexical lane universe scope identity is invalid");
  }
  return Object.freeze({
    workspace_id: value.workspace_id,
    object_ids: freezeObjectIds(value.object_ids),
    tier: value.tier
  });
}

function freezeObjectIds(value: unknown): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || !isDenseArray(value)) {
    throw new TypeError("lexical lane universe object_ids must be null or a nonempty unique list");
  }
  return freezeSortedUniqueKeys(value);
}

function freezeSortedUniqueKeys(value: readonly unknown[]): readonly string[] {
  const keys = value.map((key) => {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new TypeError("lexical lane universe candidate_keys are invalid");
    }
    return key;
  });
  for (let index = 1; index < keys.length; index += 1) {
    if (compareCodeUnits(keys[index - 1]!, keys[index]!) >= 0) {
      throw new TypeError("lexical lane universe keys must be sorted unique");
    }
  }
  return Object.freeze(keys);
}

function assertRoutedKeys(
  tokensRouted: boolean,
  applicability: LexicalLaneUniverseApplicability,
  keys: readonly string[],
  count: number
): void {
  if (count !== keys.length) {
    throw new TypeError("lexical lane universe count does not match keys");
  }
  if (!tokensRouted && (applicability.applicable || keys.length > 0)) {
    throw new TypeError("no_tokens_routed universe must be empty");
  }
}

function digestUniverse(
  body: Omit<LexicalLaneEvaluatedUniverseWitness, "universe_digest">
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    producer_id: body.producer_id,
    lane_id: body.lane_id,
    index_kind: body.index_kind,
    tokens_routed: body.tokens_routed,
    applicability: body.applicability,
    scope: {
      workspace_id: body.scope.workspace_id,
      object_ids: body.scope.object_ids,
      tier: body.scope.tier
    },
    candidate_keys: body.candidate_keys,
    count: body.count
  }), "utf8").digest("hex")}`;
}

function assertSharedRequestAxes(
  universes: readonly LexicalLaneEvaluatedUniverseWitness[]
): void {
  const first = universes[0]!;
  for (const universe of universes) {
    if (universe.scope.workspace_id !== first.scope.workspace_id) {
      throw new TypeError("lexical lane universe workspace is inconsistent");
    }
    if (!sameStringList(universe.scope.object_ids, first.scope.object_ids)) {
      throw new TypeError("lexical lane universe object_ids are inconsistent");
    }
  }
}

function assertEffectiveAppliedTiers(
  universes: readonly LexicalLaneEvaluatedUniverseWitness[]
): void {
  const dualTiers = uniqueTiers(universes, false);
  const contentTiers = uniqueTiers(universes, true);
  if (dualTiers.size > 1 || contentTiers.size > 1) {
    throw new TypeError("lexical lane universe applied tier is inconsistent");
  }
  const contentTier = [...contentTiers][0];
  const dualTier = [...dualTiers][0];
  const objectIds = universes[0]!.scope.object_ids;
  if (objectIds !== null && contentTier !== undefined && contentTier !== null) {
    throw new TypeError("content-fts universe must drop tier when object_ids are applied");
  }
  if (objectIds === null && contentTier !== undefined && contentTier !== null &&
      dualTier !== undefined && contentTier !== dualTier) {
    throw new TypeError("lexical lane universe applied tier is inconsistent");
  }
}

function uniqueTiers(
  universes: readonly LexicalLaneEvaluatedUniverseWitness[],
  contentFts: boolean
): ReadonlySet<LexicalLaneUniverseScope["tier"]> {
  return new Set(universes
    .filter((universe) => contentFtsLane(universe.lane_id) === contentFts)
    .map((universe) => universe.scope.tier));
}

function contentFtsLane(laneId: LexicalBoundLaneId): boolean {
  return laneId === "porter" || laneId === "trigram";
}

function assertObservedRowsInUniverse(lane: LexicalBoundLaneCapture): void {
  const universe = lane.evaluated_universe;
  if (universe === undefined) return;
  const keys = new Set(universe.candidate_keys);
  if (lane.rows.some((row) => !keys.has(row.candidate_key))) {
    throw new TypeError("observed candidate_key is not in the applicable universe");
  }
}

function sameStringList(
  left: readonly string[] | null,
  right: readonly string[] | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isIndexKind(value: unknown): value is LexicalLaneIndexKind {
  return value === "memory_entries" || value === "memory_content_fts_porter" ||
    value === "memory_content_fts" || value === "memory_object_key_fts" ||
    value === "memory_object_key_fts_trigram";
}

function isStorageTier(value: unknown): value is StorageTier {
  return value === "hot" || value === "warm" || value === "cold";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}
