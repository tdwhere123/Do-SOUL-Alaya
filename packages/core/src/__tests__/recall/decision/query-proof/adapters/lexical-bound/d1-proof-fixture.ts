import {
  freezeLexicalBoundProof,
  sealLexicalBoundProof,
  type LexicalBoundFieldPrefix,
  type LexicalBoundLaneCapture,
  type LexicalBoundLaneId,
  type LexicalBoundProof,
  type LexicalBoundProducerReceipt,
  type LexicalBoundRawKeyKind
} from "../../../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import {
  receiptWithUniverses,
  universeWitness
} from "../../../../runtime/diagnostics/lexical-lane-universe-fixture.js";
import type {
  D1CandidateEnvelopeMap,
  D1EnvelopeValue
} from "../../../../../../recall/decision/query-proof/adapters/lexical-bound/legal-envelope.js";

export const D1_REQUEST = `sha256:${"a".repeat(64)}`;
export const D1_SNAPSHOT = `sha256:${"b".repeat(64)}`;
export const D1_WORKSPACE = "workspace-1";

const LANE_SPECS = [
  { lane_id: "exact", raw_key_kind: "matched_token_count", source_priority: 0 },
  { lane_id: "porter", raw_key_kind: "bm25_raw_rank", source_priority: 1 },
  { lane_id: "trigram", raw_key_kind: "bm25_raw_rank", source_priority: 2 },
  { lane_id: "object_key_porter", raw_key_kind: "bm25_raw_rank", source_priority: 1 },
  { lane_id: "object_key_trigram", raw_key_kind: "bm25_raw_rank", source_priority: 2 }
] as const satisfies readonly Readonly<{
  readonly lane_id: LexicalBoundLaneId;
  readonly raw_key_kind: LexicalBoundRawKeyKind;
  readonly source_priority: 0 | 1 | 2;
}>[];

export type D1PlantedRow = Readonly<{
  readonly key: string;
  readonly ordinal: number;
  readonly raw?: number;
  readonly admitted?: boolean;
}>;

export type D1PlantedLane = Readonly<{
  readonly rows?: readonly D1PlantedRow[];
  readonly universeKeys?: readonly string[];
  readonly tokensRouted?: boolean;
  readonly limit?: number;
  readonly frontier?: "auto" | "unavailable";
}>;

export type D1PlantedProofInput = Readonly<{
  readonly fieldPrefix?: LexicalBoundFieldPrefix;
  readonly queryRunId?: string;
  readonly workspaceId?: string;
  readonly requestDigest?: string | null;
  readonly snapshotDigest?: string | null;
  readonly keyDomain?: "memory_object_id" | "omit";
  readonly universes?: boolean;
  readonly includeProvenance?: boolean;
  readonly lanes?: Readonly<Partial<Record<LexicalBoundLaneId, D1PlantedLane>>>;
}>;

export function plantProof(input: D1PlantedProofInput = {}): LexicalBoundProof {
  const workspaceId = input.workspaceId ?? D1_WORKSPACE;
  const lanes = LANE_SPECS.map((spec) => plantLane(spec, input.lanes?.[spec.lane_id]));
  const receipt = plantReceipt(
    input.queryRunId ?? "memory.keyword.depth:10",
    lanes,
    input
  );
  const attached = input.universes === false
    ? receipt
    : receiptWithUniverses(receipt, (lane) => universeWitness({
      laneId: lane.lane_id,
      candidateKeys: universeKeysFor(lane, input.lanes?.[lane.lane_id]),
      tokensRouted: input.lanes?.[lane.lane_id]?.tokensRouted ?? true,
      workspaceId
    }));
  const frozen = freezeLexicalBoundProof(attached);
  if (frozen === undefined || frozen.status !== "captured") {
    throw new Error("expected captured lexical bound proof");
  }
  return sealPlanted(frozen, input);
}

export function laneValue(
  map: D1CandidateEnvelopeMap,
  laneId: LexicalBoundLaneId
): D1EnvelopeValue | undefined {
  return map.lanes[laneId]?.value;
}

export function withIdentity(
  proof: LexicalBoundProof,
  identity: LexicalBoundProof["identity"]
): LexicalBoundProof {
  return { ...proof, identity };
}

function sealPlanted(
  proof: LexicalBoundProof,
  input: D1PlantedProofInput
): LexicalBoundProof {
  const sealed = sealLexicalBoundProof(proof, {
    ...(input.requestDigest === null
      ? {}
      : { request_digest: input.requestDigest ?? D1_REQUEST }),
    ...(input.snapshotDigest === null
      ? {}
      : { snapshot_digest: input.snapshotDigest ?? D1_SNAPSHOT }),
    workspace_id: input.workspaceId ?? D1_WORKSPACE,
    field_prefix: input.fieldPrefix ?? "lexical_relaxed",
    ...(input.keyDomain === "omit" ? {} : { candidate_key_domain: "memory_object_id" })
  });
  if (sealed.status !== "captured") throw new Error("expected captured sealed proof");
  return sealed;
}

function plantReceipt(
  queryRunId: string,
  lanes: readonly LexicalBoundLaneCapture[],
  input: D1PlantedProofInput
): LexicalBoundProducerReceipt {
  const mergeLimit = Math.max(...lanes.map((lane) => lane.requested_limit), 0);
  const provenances = input.includeProvenance === false
    ? []
    : provenancesFrom(lanes, input.lanes);
  return Object.freeze({
    schema_version: 1 as const,
    receipt_id: "alaya.recall.x0.lexical-raw-rank.v1",
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1",
    query_run_id: queryRunId,
    merge_limit: mergeLimit,
    lanes: Object.freeze(lanes),
    candidates: Object.freeze(provenances),
    post_merge: Object.freeze(provenances
      .filter((row) => row.admitted && row.post_merge_index !== null)
      .sort((left, right) => (left.post_merge_index ?? 0) - (right.post_merge_index ?? 0))
      .map((row) => Object.freeze({
        candidate_key: row.candidate_key,
        normalized_rank: row.chosen_normalized_rank ?? 1
      })))
  });
}

function plantLane(
  spec: (typeof LANE_SPECS)[number],
  plant: D1PlantedLane | undefined
): LexicalBoundLaneCapture {
  const tokensRouted = plant?.tokensRouted ?? true;
  const rows = tokensRouted ? (plant?.rows ?? []).map((row, index) => Object.freeze({
    candidate_key: row.key,
    raw_group_key: row.raw ?? defaultRaw(spec.raw_key_kind, index),
    lane_index: index,
    grouped_ordinal: row.ordinal,
    observation_state: "observed" as const
  })) : [];
  const listN = rows.length;
  const requestedLimit = plant?.limit ?? (listN === 0 ? 10 : listN + 8);
  const status = listN === 0 ? "empty" as const : listN >= requestedLimit
    ? "truncated" as const
    : "complete" as const;
  return Object.freeze({
    lane_id: spec.lane_id,
    raw_key_kind: spec.raw_key_kind,
    source_priority: spec.source_priority,
    applicability_source: "memory_fts_lane",
    list_n: listN,
    requested_limit: requestedLimit,
    status,
    rows: Object.freeze(rows),
    unseen_upper_bound: plant?.frontier === "unavailable"
      ? Object.freeze({
        status: "unavailable" as const,
        reason: "producer_order_not_monotone" as const
      })
      : status === "truncated" ? rows[rows.length - 1]!.grouped_ordinal : 0
  });
}

function universeKeysFor(
  lane: LexicalBoundLaneCapture,
  plant: D1PlantedLane | undefined
): readonly string[] {
  if (plant?.tokensRouted === false) return [];
  return plant?.universeKeys ?? lane.rows.map((row) => row.candidate_key);
}

function provenancesFrom(
  lanes: readonly LexicalBoundLaneCapture[],
  plants: D1PlantedProofInput["lanes"]
) {
  const keys = [...new Set(lanes.flatMap((lane) =>
    lane.rows.map((row) => row.candidate_key)))];
  let admittedIndex = 0;
  return keys.map((candidateKey) => {
    const hits = lanes.flatMap((lane) =>
      lane.rows.filter((row) => row.candidate_key === candidateKey).map((row) =>
        Object.freeze({
          lane_id: lane.lane_id,
          raw_group_key: row.raw_group_key,
          grouped_ordinal: row.grouped_ordinal,
          lane_index: row.lane_index
        })));
    const chosen = hits[0];
    const admitted = plantedAdmitted(candidateKey, plants);
    const postMergeIndex = admitted ? admittedIndex : null;
    if (admitted) admittedIndex += 1;
    return Object.freeze({
      candidate_key: candidateKey,
      lane_hits: Object.freeze(hits),
      admitted,
      chosen_lane_id: chosen?.lane_id ?? null,
      chosen_normalized_rank: chosen === undefined ? null : unitRank(chosen.grouped_ordinal),
      post_merge_index: postMergeIndex,
      discarded_lane_ids: Object.freeze(hits.slice(1).map((hit) => hit.lane_id))
    });
  });
}

function plantedAdmitted(
  candidateKey: string,
  plants: D1PlantedProofInput["lanes"]
): boolean {
  for (const plant of Object.values(plants ?? {})) {
    const row = plant?.rows?.find((item) => item.key === candidateKey);
    if (row?.admitted === false) return false;
  }
  return true;
}

function defaultRaw(kind: LexicalBoundRawKeyKind, index: number): number {
  return kind === "matched_token_count" ? 10 - index : index;
}

function unitRank(ordinal: number): number {
  if (ordinal > 1) return 1;
  if (ordinal < 0) return 0;
  return ordinal;
}
