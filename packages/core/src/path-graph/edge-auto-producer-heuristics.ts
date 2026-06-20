import { clamp01 } from "../shared/clamp.js";
import {
  EdgeProposalTriggerSource,
  MemoryGraphEdgeType,
  getPathAnchorBackingObjectId,
  type EdgeClassifyVerdict,
  type EdgeProposalTriggerSourceValue,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type {
  EdgeAutoProducerLlmDecision,
  EdgeAutoProducerLlmPort
} from "./edge-auto-producer-llm-port.js";
import {
  DERIVES_FROM_SEED_PROFILE,
  SUPPORTS_SEED_PROFILE,
  type PathSeedProfile
} from "./path-relation-proposal-service.js";
import type { PathCandidateSink } from "./path-candidate-sink.js";
import { CoreError } from "../shared/errors.js";
import { parseObjectId } from "../shared/validators.js";

import type { EdgeAutoDecision, SimilarityFeatures } from "./edge-auto-producer-types.js";

export const NEIGHBOR_SEARCH_LIMIT = 12;
export const MAX_EDGE_PROPOSALS_PER_MEMORY = 5;
const SUPPORTS_TOKEN_JACCARD_MIN = 0.45;
const DERIVES_TOKEN_JACCARD_MIN = 0.28;
const SUPERSEDES_TOKEN_JACCARD_MIN = 0.5;
// invariant: the local contradicts heuristic shares the supersedes token-Jaccard
// floor (0.5) — a contradicts pair must be about the same subject (high lexical
// overlap) for a negation cue between them to mean disagreement rather than two
// unrelated statements. Strong-overlap + a CONTRADICTION cue is the conservative
// signal; below this floor the pair is left to the SUPPORTS/DERIVES_FROM lanes
// or to no edge. see also: isContradictsCandidate, CONTRADICTION_CUES.
const CONTRADICTS_TOKEN_JACCARD_MIN = 0.5;
const STRONG_TAG_OVERLAP_MIN = 0.5;
// invariant: LLM pair-classifier verdicts MUST clear this confidence
// floor to enter the proposal queue. A below-floor verdict is dropped
// (the service then falls back to the local heuristic for that
// neighbor) so a noisy garden response cannot inject low-quality
// supports/derives_from proposals into the queue.
export const LLM_CONFIDENCE_FLOOR = 0.85;
// invariant: LLM-pregate floor. A pair below this token-Jaccard +
// tag-overlap threshold cannot meaningfully clear DERIVES_TOKEN_JACCARD_MIN
// (0.28) for the local heuristic either, so we skip the garden round-trip
// and fall straight back to the (likely-null) local classifier. The
// threshold is intentionally below the heuristic's DERIVES floor (the
// loosest of the three classifier paths) so the LLM still gets to see
// the "borderline" pair-space where its judgement matters most. A pair
// with zero token overlap AND zero tag overlap is the obvious-non-pair
// the pregate is meant to drop.
const LLM_PREGATE_TOKEN_JACCARD_MIN = 0.2;

const DERIVATION_CUES = [
  "based on",
  "because",
  "therefore",
  "derived from",
  "as a result",
  "follows from",
  "inferred from",
  "基于",
  "因此",
  "所以",
  "由此"
];

const REPLACEMENT_CUES = [
  "instead of",
  "replaces",
  "replace",
  "supersedes",
  "no longer",
  "deprecated",
  "rather than",
  "must not",
  "should not",
  "do not",
  "don't",
  "替代",
  "取代",
  "不再",
  "废弃",
  "改为",
  "改成",
  "不要",
  "禁止"
];

// invariant: conservative contradiction cues. These mark a new memory that
// explicitly DISAGREES WITH / NEGATES a prior claim, distinct from REPLACEMENT_CUES
// (which mark a newer-version-replaces-older supersession). The two cue sets are
// intentionally disjoint: a "no longer / replace" statement is supersedes (the
// new fact is the live one), while a "contradicts / not true / actually the
// opposite" statement is contradicts (the two facts disagree without one
// retiring the other). Bilingual (en + zh). A bare negation word like "not" is
// deliberately absent — it is too noisy; only explicit disagreement phrases
// qualify so the rule never fabricates a contradiction from incidental negation.
// see also: isContradictsCandidate, REPLACEMENT_CUES.
const CONTRADICTION_CUES = [
  "contradicts",
  "contradict",
  "is not true",
  "is false",
  "is incorrect",
  "is wrong",
  "actually the opposite",
  "on the contrary",
  "disagree with",
  "not the case",
  "矛盾",
  "相反",
  "并非",
  "不是真的",
  "是错的",
  "是错误的",
  "不对",
  "恰恰相反"
];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "use",
  "uses",
  "with"
]);

const LOCAL_SUPERSEDES_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "supersedes",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["supersession_evidence"]) as readonly string[]
});

// invariant: the local contradicts heuristic is the negative-cue sibling of
// LOCAL_SUPERSEDES_SEED_PROFILE. It is a weak local claim (a deterministic
// negation/contradiction cue between a new memory and a strong-overlap
// neighbor), NOT a SYSTEM-derived conflict ruling, so it seeds attention_only
// at recall_bias -0.4 and earns recall eligibility only through plasticity
// reinforcement — it never mints the recall_allowed/0.9 CONTRADICTS_SEED_PROFILE
// reserved for ConflictDetectionService's LLM/Jaccard verdict. Magnitude 0.4
// mirrors the contradicts entry in the SIGNAL_REF_SEED_SPECS / shared catalog so
// a local-cue contradicts and an agent-asserted contradicts_ref carry the same
// negative weight.
// see also: packages/core/src/governance/conflict-detection-service.ts — SYSTEM negatives;
//   packages/soul/src/garden/materialization-router/signal-ref-seeds.ts SIGNAL_REF_SEED_SPECS.
const LOCAL_CONTRADICTS_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "contradicts",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.4,
  evidenceBasis: Object.freeze(["contradiction_evidence"]) as readonly string[]
});

// invariant: maps the producer's edge-type verdict to the path seed
// profile that carries its initial strength / governance / recall_bias
// sign. supports + derives_from are positive associative profiles; the
// local supersedes heuristic is a weak negative lifecycle profile
// (recall_bias -, attention_only). The producer never mints exception_to.
export function seedProfileForEdgeType(edgeType: MemoryGraphEdgeTypeValue): PathSeedProfile {
  switch (edgeType) {
    case MemoryGraphEdgeType.DERIVES_FROM:
      return DERIVES_FROM_SEED_PROFILE;
    case MemoryGraphEdgeType.SUPERSEDES:
      return LOCAL_SUPERSEDES_SEED_PROFILE;
    case MemoryGraphEdgeType.CONTRADICTS:
      return LOCAL_CONTRADICTS_SEED_PROFILE;
    case MemoryGraphEdgeType.SUPPORTS:
    default:
      return SUPPORTS_SEED_PROFILE;
  }
}

export function classifyNeighbor(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): EdgeAutoDecision | null {
  if (!isEligibleNeighbor(newMemory, neighbor)) {
    return null;
  }
  const features = computeSimilarity(newMemory, neighbor);
  if (!features.strongTagOverlap) {
    return null;
  }
  if (isSupersedesCandidate(newMemory, neighbor, features)) {
    return {
      edgeType: MemoryGraphEdgeType.SUPERSEDES,
      confidence: confidence(0.55, features, 0.05, 0.85),
      reason: describeDecision("B-3 local supersedes heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_SUPERSEDES
    };
  }
  // invariant: contradicts is checked AFTER supersedes — a replacement cue is a
  // stronger retirement signal and wins when both fire. Its own LOCAL_CONTRADICTS
  // trigger_source keeps the K3.2 per-trigger KPI bucket distinct from the
  // supersedes lane.
  if (isContradictsCandidate(newMemory, features)) {
    return {
      edgeType: MemoryGraphEdgeType.CONTRADICTS,
      confidence: confidence(0.55, features, 0, 0.8),
      reason: describeDecision("B-3 local contradicts heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_CONTRADICTS
    };
  }
  if (isDerivesFromCandidate(newMemory, features)) {
    return {
      edgeType: MemoryGraphEdgeType.DERIVES_FROM,
      confidence: confidence(0.55, features, 0, 0.8),
      reason: describeDecision("B-2 local derives_from heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_DERIVES_FROM
    };
  }
  if (features.tokenJaccard >= SUPPORTS_TOKEN_JACCARD_MIN) {
    return {
      edgeType: MemoryGraphEdgeType.SUPPORTS,
      confidence: confidence(0.55, features, 0, 0.8),
      reason: describeDecision("B-2 local supports heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_SUPPORTS
    };
  }
  return null;
}

/**
 * LLM cost pregate. A pair must clear EITHER a small token-Jaccard
 * floor OR a non-empty tag-overlap signal before the LLM port is
 * consulted. The intent is to drop the "structurally eligible but
 * obviously unrelated" pairs (same workspace + dimension + scope but
 * zero shared lexical content) that would otherwise fan out to
 * NEIGHBOR_SEARCH_LIMIT garden calls per new memory under a full bench.
 *
 * The token-Jaccard floor (0.2) is intentionally below the local
 * heuristic's DERIVES_TOKEN_JACCARD_MIN (0.28) so the LLM still gets
 * the borderline pair-space where its judgement is most valuable;
 * pairs the heuristic could already classify deterministically are not
 * locked out, they just route through the LLM first as today.
 */
export function passesLlmPregate(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): boolean {
  const features = computeSimilarity(newMemory, neighbor);
  return features.tokenJaccard >= LLM_PREGATE_TOKEN_JACCARD_MIN || features.tagOverlap > 0;
}

export function isEligibleNeighbor(newMemory: Readonly<MemoryEntry>, neighbor: Readonly<MemoryEntry>): boolean {
  return (
    neighbor.object_id !== newMemory.object_id &&
    neighbor.lifecycle_state === "active" &&
    neighbor.workspace_id === newMemory.workspace_id &&
    neighbor.dimension === newMemory.dimension &&
    neighbor.scope_class === newMemory.scope_class
  );
}

function isSupersedesCandidate(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>,
  features: SimilarityFeatures
): boolean {
  return (
    newMemory.created_at > neighbor.created_at &&
    features.tokenJaccard >= SUPERSEDES_TOKEN_JACCARD_MIN &&
    hasAnyCue(newMemory.content, REPLACEMENT_CUES)
  );
}

// invariant: conservative local contradicts detection. Requires high lexical
// overlap (same subject) AND an explicit CONTRADICTION cue in the new memory.
// No created_at ordering gate (unlike supersedes): a contradiction is symmetric
// disagreement, not a newer-version replacement. The strongTagOverlap gate from
// classifyNeighbor still applies upstream, so the pair is already same-subject;
// this adds the lexical-overlap floor + the explicit-cue requirement so an
// incidental negation never fabricates a contradicts edge.
function isContradictsCandidate(
  newMemory: Readonly<MemoryEntry>,
  features: SimilarityFeatures
): boolean {
  return (
    features.tokenJaccard >= CONTRADICTS_TOKEN_JACCARD_MIN &&
    hasAnyCue(newMemory.content, CONTRADICTION_CUES)
  );
}

function isDerivesFromCandidate(
  newMemory: Readonly<MemoryEntry>,
  features: SimilarityFeatures
): boolean {
  return (
    features.tokenJaccard >= DERIVES_TOKEN_JACCARD_MIN &&
    (newMemory.formation_kind === "derived" || hasAnyCue(newMemory.content, DERIVATION_CUES))
  );
}

function computeSimilarity(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): SimilarityFeatures {
  const tokenJaccard = jaccard(tokenize(newMemory.content), tokenize(neighbor.content));
  const tagOverlap = overlapRatio(normalizeLabels(newMemory.domain_tags), normalizeLabels(neighbor.domain_tags));
  return {
    tokenJaccard,
    tagOverlap,
    strongTagOverlap: tagOverlap >= STRONG_TAG_OVERLAP_MIN
  };
}

function tokenize(content: string): readonly string[] {
  return Array.from(
    new Set(
      content
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.filter((token) => token.length > 1 && !STOPWORDS.has(token)) ?? []
    )
  );
}

function normalizeLabels(labels: readonly string[]): readonly string[] {
  return Array.from(new Set(labels.map((label) => label.normalize("NFKC").toLowerCase().trim()).filter(Boolean)));
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const intersection = left.filter((token) => rightSet.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function overlapRatio(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const intersection = left.filter((tag) => rightSet.has(tag)).length;
  return intersection / Math.min(left.length, right.length);
}

function hasAnyCue(content: string, cues: readonly string[]): boolean {
  const normalized = content.normalize("NFKC").toLowerCase();
  return cues.some((cue) => normalized.includes(cue));
}

function confidence(
  base: number,
  features: SimilarityFeatures,
  bonus: number,
  max: number
): number {
  const value = base + features.tokenJaccard * 0.2 + features.tagOverlap * 0.1 + bonus;
  return round2(Math.min(max, Math.max(0.55, value)));
}

function describeDecision(label: string, features: SimilarityFeatures): string {
  return `${label}: token_jaccard=${round2(features.tokenJaccard)}, tag_overlap=${round2(features.tagOverlap)}`;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
