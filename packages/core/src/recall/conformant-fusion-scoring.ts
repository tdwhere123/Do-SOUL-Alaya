import {
  decorrelateFamily,
  gateSurfaceByEmbedding,
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
import {
  scoreTemporalEventTime,
  scoreTemporalQueryWindow,
  type QueryTimeWindow
} from "./temporal-fusion-scoring.js";

export const CONFORMANT_AXES: readonly RecallConformantAxis[] = ["object", "path", "evidence"];

// Object lexical surface — correlated views collapsed by pure max (λ=0); never the per-stream families
// (which mis-file temporal/source_* streams), so it is intentionally NOT a reuse of STREAM_FAMILY.
const LEXICAL_SURFACE: readonly RecallFusionStream[] = [
  "lexical_fts", "trigram_fts", "synthesis_fts", "evidence_fts", "evidence_structural_agreement"
];
const EVIDENCE_STREAMS: readonly RecallFusionStream[] = ["source_proximity", "source_evidence_agreement"];

const RA_QUANTUM = 1e-9;

function flagEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw === "on" || raw === "1" || raw === "true";
}

export function conformantFusionEnabled(): boolean {
  return flagEnabled("ALAYA_RECALL_CONFORMANT");
}

// Evidence-decay (scoreTemporalEventTime) into R_E; default OFF keeps R_E iron-law-clean support strength.
export function conformantEvidenceDecayEnabled(): boolean {
  return flagEnabled("ALAYA_RECALL_CONF_EVIDENCE_DECAY");
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

// λ applied ONLY to the genuinely-correlated subject/structural and source pairs; the lexical/topology
// clusters always use λ=0 (pure max) so correlated views never multi-count.
export function resolveConformantLambda(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_LAMBDA", 0.5);
}

export function resolveConformantGateFloor(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_GATE_FLOOR", 0.5);
}

// W_P: path-flood weight in activation = R_O + W_P·flood. Bounded; flood is compositional so this never injects an independent vote.
export function resolveConformantPathWeight(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_W_PATH", 0.6, 0);
}

// β: evidence multiplicative boost g(R_E)=1+β·R_E, g(0)=1. Evidence supports memory; no evidence never penalizes.
export function resolveConformantEvidenceBeta(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_EVIDENCE_BETA", 0.5, 0);
}

// Governance: max effect one learned path may apply in a single flood round.
export function resolveConformantFloodCapPerSource(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_FLOOD_CAP", 1, 0);
}

// Governance: ceiling on a target's total inflow flood across converging sources.
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

// R_O = embedding-gated lexical surface (pure-max) + embedding + facet + λ·(subject,structural) + object-time.
export function collapseObjectRelevance(
  inputs: CollapseInputs,
  embeddingPoolMax: number,
  queryWindow: QueryTimeWindow | null,
  intent: RecallQueryIntent,
  lambda: number,
  gateFloor: number
): number {
  const lexCollapsed = decorrelateFamily(LEXICAL_SURFACE.map((stream) => streamRelevance(inputs, stream)), 0);
  const effectiveGateFloor = intent === "single_fact" ? 1 : gateFloor;
  const gatedSurface = gateSurfaceByEmbedding(lexCollapsed, inputs.candidate, effectiveGateFloor, embeddingPoolMax);
  const embeddingRel = streamRelevance(inputs, "embedding_similarity");
  const facetRel = streamRelevance(inputs, "facet_overlap");
  const subjectStructural = decorrelateFamily(
    [streamRelevance(inputs, "subject_alignment"), streamRelevance(inputs, "structural")],
    lambda
  );
  const objectTimeRel = queryWindow === null ? 0 : scoreTemporalQueryWindow(inputs.candidate.entry, queryWindow);
  return gatedSurface + embeddingRel + facetRel + subjectStructural + objectTimeRel;
}

// R_E = λ·(source_proximity, source_evidence_agreement); evidence-decay added raw only behind the sub-flag.
export function collapseEvidenceRelevance(inputs: CollapseInputs, nowIso: string, lambda: number): number {
  let relevance = decorrelateFamily(EVIDENCE_STREAMS.map((stream) => streamRelevance(inputs, stream)), lambda);
  if (conformantEvidenceDecayEnabled()) {
    relevance += scoreTemporalEventTime(inputs.candidate.entry, nowIso);
  }
  return relevance;
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

interface SeededCandidate {
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
  readonly nowIso: string;
  readonly intent: RecallQueryIntent;
}>): ConformantAxisContext {
  const lambda = resolveConformantLambda();
  const gateFloor = resolveConformantGateFloor();
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
      object: quantize(
        collapseObjectRelevance(inputs, params.embeddingPoolMax, params.queryWindow, params.intent, lambda, gateFloor)
      ),
      evidence: quantize(collapseEvidenceRelevance(inputs, params.nowIso, lambda))
    };
  });
  return assembleCompositionalScores(seeded, params.supplementaryData.pathInflowByTarget);
}

// Governed flood: Σ_edges min(R_O(seed)·π, capPerSource) capped per inflow edge (one learned path), summed and capped at capTotal. Caps the flood only.
function governedFlood(
  inflow: readonly PathInflowEdge[] | undefined,
  rObjectById: ReadonlyMap<string, number>,
  capPerSource: number,
  capTotal: number
): number {
  if (inflow === undefined) {
    return 0;
  }
  let sum = 0;
  for (const edge of inflow) {
    const seedRelevance = rObjectById.get(edge.seedObjectId);
    if (seedRelevance === undefined || seedRelevance <= 0) {
      continue;
    }
    sum += Math.min(seedRelevance * edge.weight, capPerSource);
  }
  return Math.min(sum, capTotal);
}

// Pass 2: activation = R_O + W_P·Gov[flood]; S = activation·(1+β·R_E). Path floods compositionally; evidence boosts multiplicatively (g(0)=1).
function assembleCompositionalScores(
  seeded: readonly SeededCandidate[],
  inflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>> | undefined
): ConformantAxisContext {
  const pathWeight = resolveConformantPathWeight();
  const beta = resolveConformantEvidenceBeta();
  const capPerSource = resolveConformantFloodCapPerSource();
  const capTotal = resolveConformantFloodCapTotal();
  const rObjectById = new Map<string, number>();
  for (const candidate of seeded) {
    rObjectById.set(candidate.objectId, Math.max(rObjectById.get(candidate.objectId) ?? 0, candidate.object));
  }
  const scoreByKey = new Map<string, number>();
  const axisRankByKey = new Map<string, Readonly<Record<RecallConformantAxis, number | null>>>();
  const raByKey = new Map<string, Readonly<Record<RecallConformantAxis, number>>>();
  for (const candidate of seeded) {
    const flood = quantize(governedFlood(inflowByTarget?.[candidate.objectId], rObjectById, capPerSource, capTotal));
    const activation = candidate.object + pathWeight * flood;
    scoreByKey.set(candidate.candidateKey, activation * (1 + beta * candidate.evidence));
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
