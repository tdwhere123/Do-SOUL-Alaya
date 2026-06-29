import {
  noisyOrDecorrelate,
  resolveBestEvidenceRelevance,
  type FloodStreamScores
} from "./flood-fusion-scoring.js";
import type {
  FusionContributionCandidate,
  ResolvedRecallFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import type { RecallQueryIntent } from "./recall-query-plan.js";
import type {
  PathInflowEdge,
  RecallConformantAxis,
  RecallFusionStream,
  RecallSupplementaryData
} from "./recall-service-types.js";
import { scoreTemporalQueryWindow, type QueryTimeWindow } from "./temporal-fusion-scoring.js";
import { normalizeGraphSupport } from "./recall-service-helpers.js";
import { clamp01 } from "../shared/clamp.js";

export const CONFORMANT_AXES: readonly RecallConformantAxis[] = ["object", "path", "evidence"];

// R_lex surface (L1 object axis): correlated lexical views folded by NOR_ρ, not re-counted additively.
const LEXICAL_SURFACE: readonly RecallFusionStream[] = [
  "lexical_fts", "trigram_fts", "synthesis_fts", "evidence_fts", "evidence_structural_agreement"
];
// Topic-echo views: down-weighted confidence so a redundant view contributes less than the primary surface.
const LEXICAL_ECHO_STREAMS: ReadonlySet<RecallFusionStream> = new Set(["trigram_fts", "synthesis_fts"]);
const SUBJECT_STREAMS: readonly RecallFusionStream[] = ["subject_alignment", "structural"];
// R_E stream-based support (query-lexical-orthogonal): reliability-weighted session/source propagation.
// evidence_fts and source_evidence_agreement both derive from evidence_fts (query-lexical), so reusing
// either would make ∂R_E/∂L≠0 — they stay in R_lex and are intentionally excluded here.
const EVIDENCE_SUPPORT_STREAMS: readonly RecallFusionStream[] = ["source_proximity"];

const RA_QUANTUM = 1e-9;
// decay_ev: evidence-axis own plasticity decay; identity placeholder this round (never reuses temporal).
const EVIDENCE_DECAY = 1;

function flagEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw === "on" || raw === "1" || raw === "true";
}

// Kill-switch: ALAYA_RECALL_FLAT_BASELINE=on reverts recall to the legacy flat/flood routing.
export function flatBaselineEnabled(): boolean {
  return flagEnabled("ALAYA_RECALL_FLAT_BASELINE");
}

// Four-axis assembly is the production default; only the flat-baseline kill-switch turns it off.
export function fourAxisAssemblyEnabled(): boolean {
  return !flatBaselineEnabled();
}

function readUnitEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function readFloatEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

// ρ_lex: lexical de-correlation. single_fact is forced to 1 (pure max) at the call site.
export function resolveConformantRhoLex(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_RHO_LEX", 0.6);
}

export function resolveConformantRhoSub(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_RHO_SUB", 0.5);
}

export function resolveConformantRhoPath(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_RHO_PATH", 0.5);
}

export function resolveConformantRhoEvidence(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_RHO_EVIDENCE", 0.5);
}

// Topic-echo view confidence cᵢ for trigram/synthesis surfaces in R_lex.
export function resolveConformantEchoConfidence(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_ECHO", 0.6);
}

// c_surf: surface-facet confidence in the cross-facet noisy-OR R_O; surface stays the primary lens (<1 leaves
// headroom for the embedding co-facet to lift).
export function resolveConformantCSurf(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_C_SURF", 0.9);
}

// c_emb: embedding-facet confidence — a co-equal semantic facet that lifts but never demotes R_O.
// single_fact forces it to 0 at the call site (lexical is truth; an STS model must not touch it).
export function resolveConformantCEmb(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_C_EMB", 0.7);
}

// δ_stale: ω for a stale durable source under object arbitration (winner=1 / contested-loser=0).
export function resolveConformantStaleGovernance(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_STALE", 0.5);
}

// W_P: path-flood weight in prob-OR activation A=1−(1−R_O)(1−W_P·Φ); bounded so Φ never injects a free vote.
export function resolveConformantPathWeight(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_W_PATH", 0.6, 0);
}

// β: evidence multiplicative gain g(R_E)=1+β·R_E, g(0)=1. Evidence supports memory; absence never penalizes.
export function resolveConformantEvidenceBeta(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_EVIDENCE_BETA", 0.5, 0);
}

// cap_src: max π-flood one learned inflow edge may carry before the NOR fold.
export function resolveConformantFloodCapPerSource(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_FLOOD_CAP", 1, 0);
}

// cap_tot: ceiling on the folded inflow (NOR≤1 already bounds it; this clamps further when set below 1).
export function resolveConformantFloodCapTotal(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL", 3, 0);
}

function quantize(value: number): number {
  return Math.round(value / RA_QUANTUM) * RA_QUANTUM;
}

type CollapseInputs = Readonly<{
  readonly candidate: FusionContributionCandidate;
  readonly candidateKey: string;
  readonly scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores>;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly supplementaryData: RecallSupplementaryData;
}>;

function streamRelevance(inputs: CollapseInputs, stream: RecallFusionStream): number {
  const streamScores = inputs.scoresByStream.get(stream);
  if (streamScores === undefined) {
    return 0;
  }
  return resolveBestEvidenceRelevance({
    candidate: inputs.candidate,
    supplementaryData: inputs.supplementaryData,
    resolved: inputs.resolved,
    stream,
    rawScore: streamScores.scoreByKey.get(inputs.candidateKey) ?? 0,
    streamMax: streamScores.max
  });
}

// R_emb = clamp01(embedding_similarity / embeddingPoolMax): pool-relative semantic relevance, never raw cosine.
function embeddingRelevance(candidate: FusionContributionCandidate, embeddingPoolMax: number): number {
  const similarity = candidate.effectiveFactors.embedding_similarity;
  if (typeof similarity !== "number" || similarity <= 0 || embeddingPoolMax <= 0) {
    return 0;
  }
  return clamp01(similarity / embeddingPoolMax);
}

// R_O = 1 − (1−c_surf·R_surf)·(1−c_emb·R_emb)·(1−R_facet)·(1−R_time)·(1−R_sub): cross-facet noisy-OR. Embedding is a
// co-equal semantic facet — present it lifts R_O, absent (R_emb=0) the factor is 1 (identity, never demotes lexical truth).
// single_fact forces ρ_surf→1 (pure max) and c_emb→0 so co-topical multi-firing / STS false-friends can't out-rank gold.
export function collapseObjectRelevance(
  inputs: CollapseInputs,
  embeddingPoolMax: number,
  queryWindow: QueryTimeWindow | null,
  intent: RecallQueryIntent,
  rhoLex: number,
  rhoSub: number
): number {
  const echo = resolveConformantEchoConfidence();
  const lexValues = LEXICAL_SURFACE.map((stream) => streamRelevance(inputs, stream));
  const lexConfidence = LEXICAL_SURFACE.map((stream) => (LEXICAL_ECHO_STREAMS.has(stream) ? echo : 1));
  const effectiveRhoLex = intent === "single_fact" ? 1 : rhoLex;
  const rSurf = noisyOrDecorrelate(lexValues, lexConfidence, effectiveRhoLex);
  const rEmb = embeddingRelevance(inputs.candidate, embeddingPoolMax);
  const cEmb = intent === "single_fact" ? 0 : resolveConformantCEmb();
  const facet = streamRelevance(inputs, "facet_overlap");
  const time = queryWindow === null ? 0 : scoreTemporalQueryWindow(inputs.candidate.entry, queryWindow);
  const sub = noisyOrDecorrelate(SUBJECT_STREAMS.map((stream) => streamRelevance(inputs, stream)), [1, 1], rhoSub);
  let complement = (1 - resolveConformantCSurf() * clamp01(rSurf)) * (1 - cEmb * clamp01(rEmb));
  for (const facetValue of [facet, time, sub]) {
    complement *= 1 - clamp01(facetValue);
  }
  return clamp01(1 - complement);
}

// Normalized independent-support count: the query-orthogonal inbound graph-support tally (∂/∂L=0),
// the spec's 归一独立支撑计数 half of R_E support.
function independentSupportCount(inputs: CollapseInputs): number {
  return normalizeGraphSupport(inputs.supplementaryData.graphSupportCounts[inputs.candidate.entry.object_id] ?? 0);
}

// R_E = decay_ev · NOR_{ρ_ev}({reliability-weighted source support, normalized independent-support count}).
// Both supports are query-lexical-orthogonal (session propagation + inbound graph tally), so ∂R_E/∂L=0;
// ρ_ev folds the two so it is live tuning, not an inert single-element no-op. Never reuses evidence_fts
// (R_lex) or scoreTemporalEventTime (temporal).
export function collapseEvidenceRelevance(inputs: CollapseInputs, rhoEvidence: number): number {
  const support = [
    ...EVIDENCE_SUPPORT_STREAMS.map((stream) => streamRelevance(inputs, stream)),
    independentSupportCount(inputs)
  ];
  return EVIDENCE_DECAY * noisyOrDecorrelate(support, support.map(() => 1), rhoEvidence);
}

export interface ConformantCandidate {
  readonly candidateKey: string;
  readonly candidate: FusionContributionCandidate;
}

export interface ConformantAxisContext {
  readonly scoreByKey: ReadonlyMap<string, number>;
  readonly axisRankByKey: ReadonlyMap<string, Readonly<Record<RecallConformantAxis, number | null>>>;
  readonly raByKey: ReadonlyMap<string, Readonly<Record<RecallConformantAxis, number>>>;
}

export interface SeededCandidate {
  readonly candidateKey: string;
  readonly objectId: string;
  readonly object: number;
  readonly evidence: number;
}

const NULL_AXIS_RANK: Readonly<Record<RecallConformantAxis, number | null>> =
  Object.freeze({ object: null, path: null, evidence: null });

// Pass 1: collapse the object SEED (R_O) and evidence support (R_E) for every candidate.
export function buildConformantAxisContext(params: Readonly<{
  readonly candidates: readonly ConformantCandidate[];
  readonly scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores>;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly supplementaryData: RecallSupplementaryData;
  readonly embeddingPoolMax: number;
  readonly queryWindow: QueryTimeWindow | null;
  readonly intent: RecallQueryIntent;
}>): ConformantAxisContext {
  const rhoLex = resolveConformantRhoLex();
  const rhoSub = resolveConformantRhoSub();
  const rhoEvidence = resolveConformantRhoEvidence();
  const seeded: SeededCandidate[] = params.candidates.map(({ candidateKey, candidate }) => {
    const inputs: CollapseInputs = {
      candidate,
      candidateKey,
      scoresByStream: params.scoresByStream,
      resolved: params.resolved,
      supplementaryData: params.supplementaryData
    };
    return {
      candidateKey,
      objectId: candidate.entry.object_id,
      object: quantize(collapseObjectRelevance(inputs, params.embeddingPoolMax, params.queryWindow, params.intent, rhoLex, rhoSub)),
      evidence: quantize(collapseEvidenceRelevance(inputs, rhoEvidence))
    };
  });
  return assembleCompositionalScores(seeded, params.supplementaryData.pathInflowByTarget);
}

// Φ(o) = min(NOR_{ρ_path}({min(R_O(s)·π, cap_src) : e=(s→o), s≠o}), cap_tot). Self-loops and π=0 co-occurrence
// edges carry no flood; the NOR fold keeps the total bounded in [0,1] before the optional cap_tot clamp.
function collapsePathInflow(
  inflow: readonly PathInflowEdge[] | undefined,
  targetObjectId: string,
  rObjectById: ReadonlyMap<string, number>,
  capPerSource: number,
  capTotal: number,
  rhoPath: number
): number {
  if (inflow === undefined) {
    return 0;
  }
  const supports: number[] = [];
  for (const edge of inflow) {
    if (edge.seedObjectId === targetObjectId) {
      continue;
    }
    const seedRelevance = rObjectById.get(edge.seedObjectId);
    if (seedRelevance === undefined || seedRelevance <= 0 || edge.weight <= 0) {
      continue;
    }
    supports.push(Math.min(seedRelevance * edge.weight, capPerSource));
  }
  return Math.min(noisyOrDecorrelate(supports, supports.map(() => 1), rhoPath), capTotal);
}

// Pass 2: A = 1 − (1−R_O)(1−W_P·Φ) (prob-OR); S = ω·A·(1+β·R_E). ω is the object-arbitration scale
// (identity placeholder until a winner/stale/loser source is wired). raByKey records {R_O, Φ, R_E}.
export function assembleCompositionalScores(
  seeded: readonly SeededCandidate[],
  inflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>> | undefined,
  governanceByObjectId?: ReadonlyMap<string, number>
): ConformantAxisContext {
  const pathWeight = clamp01(resolveConformantPathWeight());
  const beta = resolveConformantEvidenceBeta();
  const capPerSource = resolveConformantFloodCapPerSource();
  const capTotal = resolveConformantFloodCapTotal();
  const rhoPath = resolveConformantRhoPath();
  const rObjectById = new Map<string, number>();
  for (const candidate of seeded) {
    rObjectById.set(candidate.objectId, Math.max(rObjectById.get(candidate.objectId) ?? 0, candidate.object));
  }
  const scoreByKey = new Map<string, number>();
  const axisRankByKey = new Map<string, Readonly<Record<RecallConformantAxis, number | null>>>();
  const raByKey = new Map<string, Readonly<Record<RecallConformantAxis, number>>>();
  for (const candidate of seeded) {
    const flood = quantize(
      collapsePathInflow(inflowByTarget?.[candidate.objectId], candidate.objectId, rObjectById, capPerSource, capTotal, rhoPath)
    );
    const activation = 1 - (1 - candidate.object) * (1 - pathWeight * flood);
    const omega = clamp01(governanceByObjectId?.get(candidate.objectId) ?? 1);
    scoreByKey.set(candidate.candidateKey, omega * activation * (1 + beta * candidate.evidence));
    axisRankByKey.set(candidate.candidateKey, NULL_AXIS_RANK);
    raByKey.set(
      candidate.candidateKey,
      Object.freeze({ object: candidate.object, path: flood, evidence: candidate.evidence })
    );
  }
  return Object.freeze({ scoreByKey, axisRankByKey, raByKey });
}

// R_a magnitude vector tie-break (object → path → evidence); 0 when either vector is absent (flag-off).
export function compareConformantAxisRa(
  left: Readonly<Record<RecallConformantAxis, number>> | undefined,
  right: Readonly<Record<RecallConformantAxis, number>> | undefined
): number {
  if (left === undefined || right === undefined) {
    return 0;
  }
  for (const axis of CONFORMANT_AXES) {
    const delta = right[axis] - left[axis];
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}
