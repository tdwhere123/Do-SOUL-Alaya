import { createHash } from "node:crypto";
import {
  verifyLexicalBoundProof,
  type LexicalBoundFieldPrefix,
  type LexicalBoundLaneCapture,
  type LexicalBoundProof,
  type LexicalBoundProofCaptured,
  type LexicalLaneEvaluatedUniverseWitness
} from "../../runtime/diagnostics/lexical-bound-proof.js";
import {
  parseLexDomain,
  type LexDomain,
  type LexLaneId
} from "../observations.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UNBOUNDED = Object.freeze({ kind: "unbounded" as const });
const INAPPLICABLE = Object.freeze({ kind: "inapplicable" as const });

export type D1IntervalEnvelope = Readonly<{
  readonly kind: "interval";
  readonly lower: number;
  readonly upper: number;
}>;

export type D1EnvelopeValue =
  | D1IntervalEnvelope
  | Readonly<{ readonly kind: "unbounded" }>
  | Readonly<{ readonly kind: "inapplicable" }>;

export type D1EnvelopeIdentity = Readonly<{
  readonly field_prefix: LexicalBoundFieldPrefix;
  readonly query_run_id: string;
  readonly snapshot_digest: string;
  readonly request_digest: string;
  readonly workspace_id: string;
}>;

export type D1LaneEnvelope = Readonly<{
  readonly domain: LexDomain | null;
  readonly value: D1EnvelopeValue;
}>;

export type D1PrimaryObservation = Readonly<{
  readonly domain: LexDomain;
  readonly envelope: D1IntervalEnvelope;
}>;

export type D1CandidateEnvelopeMap = Readonly<{
  readonly identity: D1EnvelopeIdentity | null;
  readonly field_prefix: LexicalBoundFieldPrefix | null;
  readonly query_run_id: string | null;
  readonly snapshot_digest: string | null;
  readonly request_digest: string | null;
  readonly primary: D1PrimaryObservation | null;
  readonly lanes: Readonly<Partial<Record<LexLaneId, D1LaneEnvelope>>>;
}>;

export function d1LaneEnvelopes(
  proof: LexicalBoundProof,
  candidateKey: string
): D1CandidateEnvelopeMap {
  if (proof.status !== "captured") return emptyEnvelopes();
  const verifiable = proofVerifiable(proof);
  const identity = verifiable ? readIdentity(proof) : null;
  const proofLegal = identity !== null && proof.candidate_key_domain === "memory_object_id";
  const lanes = lanesFrom(proof, candidateKey, proofLegal ? identity : null);
  return Object.freeze({
    identity: proofLegal ? identity : null,
    field_prefix: identity?.field_prefix ?? null,
    query_run_id: proof.receipt.query_run_id,
    snapshot_digest: sealedDigest(proof.identity.snapshot_digest),
    request_digest: sealedDigest(proof.identity.request_digest),
    primary: proofLegal ? primaryOf(proof, candidateKey, lanes) : null,
    lanes
  });
}

export function d1IdentitiesEqual(
  left: D1EnvelopeIdentity,
  right: D1EnvelopeIdentity
): boolean {
  return left.field_prefix === right.field_prefix &&
    left.query_run_id === right.query_run_id &&
    left.snapshot_digest === right.snapshot_digest &&
    left.request_digest === right.request_digest &&
    left.workspace_id === right.workspace_id;
}

export function d1HasLegalEnvelope(map: D1CandidateEnvelopeMap): boolean {
  return Object.values(map.lanes).some((lane) =>
    lane !== undefined && lane.value.kind === "interval");
}

function lanesFrom(
  proof: LexicalBoundProofCaptured,
  candidateKey: string,
  identity: D1EnvelopeIdentity | null
): D1CandidateEnvelopeMap["lanes"] {
  const lanes: Partial<Record<LexLaneId, D1LaneEnvelope>> = {};
  for (const lane of proof.receipt.lanes) {
    lanes[lane.lane_id] = laneEnvelope(lane, candidateKey, identity);
  }
  return Object.freeze(lanes);
}

function laneEnvelope(
  lane: LexicalBoundLaneCapture,
  candidateKey: string,
  identity: D1EnvelopeIdentity | null
): D1LaneEnvelope {
  const domain = tryLexDomain(lane);
  if (identity === null || domain === null) {
    return Object.freeze({ domain, value: UNBOUNDED });
  }
  return Object.freeze({ domain, value: laneValue(lane, candidateKey, identity) });
}

function laneValue(
  lane: LexicalBoundLaneCapture,
  candidateKey: string,
  identity: D1EnvelopeIdentity
): D1EnvelopeValue {
  const universe = lane.evaluated_universe;
  if (universe === undefined || !universeDigestValid(universe, lane.lane_id)) {
    return UNBOUNDED;
  }
  if (universe.scope.workspace_id !== identity.workspace_id) return UNBOUNDED;
  if (!universe.applicability.applicable) return INAPPLICABLE;
  if (!universe.candidate_keys.includes(candidateKey)) return UNBOUNDED;
  const closure = classifyClosure(lane);
  if (closure === "unbounded") return UNBOUNDED;
  const row = lane.rows.find((item) => item.candidate_key === candidateKey);
  if (row !== undefined) return pointEnvelope(row.grouped_ordinal);
  if (closure === "closed") return Object.freeze({ kind: "interval", lower: 0, upper: 0 });
  return truncatedAbsence(lane.unseen_upper_bound);
}

function primaryOf(
  proof: LexicalBoundProofCaptured,
  candidateKey: string,
  lanes: D1CandidateEnvelopeMap["lanes"]
): D1PrimaryObservation | null {
  const provenance = proof.receipt.candidates.find((row) =>
    row.candidate_key === candidateKey);
  if (provenance?.chosen_lane_id === null || provenance?.chosen_lane_id === undefined) {
    return null;
  }
  const lane = proof.receipt.lanes.find((item) => item.lane_id === provenance.chosen_lane_id);
  if (lane === undefined || !lane.rows.some((row) => row.candidate_key === candidateKey)) {
    return null;
  }
  const view = lanes[provenance.chosen_lane_id];
  if (view?.domain === null || view?.domain === undefined) return null;
  if (view.value.kind !== "interval" || view.value.lower !== view.value.upper) return null;
  return Object.freeze({ domain: view.domain, envelope: view.value });
}

function classifyClosure(
  lane: LexicalBoundLaneCapture
): "closed" | "truncated" | "unbounded" {
  if (lane.status === "complete" || lane.status === "empty") {
    return lane.unseen_upper_bound === 0 ? "closed" : "unbounded";
  }
  if (!rankingKeysMonotone(lane)) return "unbounded";
  if (typeof lane.unseen_upper_bound !== "number") return "unbounded";
  const last = lane.rows.at(-1)?.grouped_ordinal;
  if (last === undefined || lane.unseen_upper_bound !== last) return "unbounded";
  return "truncated";
}

function rankingKeysMonotone(lane: LexicalBoundLaneCapture): boolean {
  for (let index = 1; index < lane.rows.length; index += 1) {
    const previous = lane.rows[index - 1]!.raw_group_key;
    const next = lane.rows[index]!.raw_group_key;
    if (lane.raw_key_kind === "bm25_raw_rank" && next < previous) return false;
    if (lane.raw_key_kind === "matched_token_count" && next > previous) return false;
  }
  return true;
}

function universeDigestValid(
  universe: LexicalLaneEvaluatedUniverseWitness,
  laneId: LexicalBoundLaneCapture["lane_id"]
): boolean {
  if (universe.lane_id !== laneId) return false;
  if (!DIGEST.test(universe.universe_digest)) return false;
  return universe.universe_digest === expectedUniverseDigest(universe);
}

function expectedUniverseDigest(
  universe: LexicalLaneEvaluatedUniverseWitness
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    producer_id: universe.producer_id,
    lane_id: universe.lane_id,
    index_kind: universe.index_kind,
    tokens_routed: universe.tokens_routed,
    applicability: universe.applicability,
    scope: {
      workspace_id: universe.scope.workspace_id,
      object_ids: universe.scope.object_ids,
      tier: universe.scope.tier
    },
    candidate_keys: universe.candidate_keys,
    count: universe.count
  }), "utf8").digest("hex")}`;
}

function readIdentity(proof: LexicalBoundProofCaptured): D1EnvelopeIdentity | null {
  const prefix = sealedPrefix(proof.field_prefix);
  const snapshot = sealedDigest(proof.identity.snapshot_digest);
  const request = sealedDigest(proof.identity.request_digest);
  const workspace = sealedWorkspace(proof.identity.workspace_id);
  const queryRunId = proof.receipt.query_run_id;
  if (prefix === null || snapshot === null || request === null || workspace === null) {
    return null;
  }
  if (snapshot === request || queryRunId.trim().length === 0) return null;
  return Object.freeze({
    field_prefix: prefix,
    query_run_id: queryRunId,
    snapshot_digest: snapshot,
    request_digest: request,
    workspace_id: workspace
  });
}

function proofVerifiable(proof: LexicalBoundProof): boolean {
  try {
    verifyLexicalBoundProof(proof);
    return true;
  } catch {
    return false;
  }
}

function tryLexDomain(lane: LexicalBoundLaneCapture): LexDomain | null {
  try {
    return parseLexDomain({
      lane_id: lane.lane_id,
      list_n: lane.list_n,
      status: lane.status,
      raw_key_kind: lane.raw_key_kind
    });
  } catch {
    return null;
  }
}

function pointEnvelope(value: number): D1EnvelopeValue {
  if (!Number.isFinite(value)) return UNBOUNDED;
  return Object.freeze({ kind: "interval", lower: value, upper: value });
}

function truncatedAbsence(upper: LexicalBoundLaneCapture["unseen_upper_bound"]): D1EnvelopeValue {
  if (typeof upper !== "number" || !Number.isFinite(upper) || upper < 0) return UNBOUNDED;
  return Object.freeze({ kind: "interval", lower: 0, upper });
}

function sealedPrefix(value: unknown): LexicalBoundFieldPrefix | null {
  return value === "lexical_relaxed" || value === "lexical_expanded" ? value : null;
}

function sealedDigest(value: unknown): string | null {
  return typeof value === "string" && DIGEST.test(value) ? value : null;
}

function sealedWorkspace(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function emptyEnvelopes(): D1CandidateEnvelopeMap {
  return Object.freeze({
    identity: null,
    field_prefix: null,
    query_run_id: null,
    snapshot_digest: null,
    request_digest: null,
    primary: null,
    lanes: Object.freeze({})
  });
}
