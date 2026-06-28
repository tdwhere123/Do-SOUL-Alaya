import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { compareMemoryEntries } from "./recall-service-helpers.js";
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
const PATH_STREAMS: readonly RecallFusionStream[] = ["path_expansion", "graph_expansion", "entity_seed"];
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

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : fallback;
}

// λ applied ONLY to the genuinely-correlated subject/structural and source pairs; the lexical/topology
// clusters always use λ=0 (pure max) so correlated views never multi-count.
export function resolveConformantLambda(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_LAMBDA", 0.5);
}

export function resolveConformantGateFloor(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_GATE_FLOOR", 0.5);
}

export function resolveConformantGovFloor(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_GOV_FLOOR", 0, 0);
}

export function resolveConformantGovRatio(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_GOV_RATIO", 1, 0);
}

// Lifts top-of-pool S into the additive band so applyPathSuppressionToFusionScores' absolute deltas stay
// meaningful; order-invariant, so ranking is unaffected.
export function resolveConformantScale(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_SCALE", 20, 0);
}

// k=20 (not the per-stream 45-90 / RRF-60): with only 3 votes, top-rank-on-orthogonal must stay decisive.
export function resolveConformantAxisK(axis: RecallConformantAxis): number {
  const base = readPositiveIntEnv("ALAYA_RECALL_CONF_K", 20);
  const perAxis =
    axis === "object" ? "ALAYA_RECALL_CONF_K_OBJECT"
      : axis === "path" ? "ALAYA_RECALL_CONF_K_PATH"
        : "ALAYA_RECALL_CONF_K_EVIDENCE";
  return readPositiveIntEnv(perAxis, base);
}

export interface ConformantAxisWeights {
  readonly object: number;
  readonly path: number;
  readonly evidence: number;
}

// W_P+W_E=1.2 > W_O=1.0: two corroborating orthogonal axes can overcome a lexical-only Object.
export function resolveConformantWeights(): ConformantAxisWeights {
  return {
    object: readFloatEnv("ALAYA_RECALL_CONF_W_OBJECT", 1.0, 0),
    path: readFloatEnv("ALAYA_RECALL_CONF_W_PATH", 0.6, 0),
    evidence: readFloatEnv("ALAYA_RECALL_CONF_W_EVIDENCE", 0.6, 0)
  };
}

// Cap the Object vote at floor + ratio·orthogonal; no orthogonal evidence ⇒ no penalty (early return).
export function applyConformantGovernance(objectVote: number, orthogonalSum: number): number {
  if (orthogonalSum <= 0) {
    return objectVote;
  }
  return Math.min(objectVote, resolveConformantGovFloor() + resolveConformantGovRatio() * orthogonalSum);
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

// R_P = pure-max over the three path streams (same topology, never λ-sum).
export function collapsePathRelevance(inputs: CollapseInputs): number {
  return decorrelateFamily(PATH_STREAMS.map((stream) => streamRelevance(inputs, stream)), 0);
}

// R_E = λ·(source_proximity, source_evidence_agreement); evidence-decay added raw only behind the sub-flag.
export function collapseEvidenceRelevance(inputs: CollapseInputs, nowIso: string, lambda: number): number {
  let relevance = decorrelateFamily(EVIDENCE_STREAMS.map((stream) => streamRelevance(inputs, stream)), lambda);
  if (conformantEvidenceDecayEnabled()) {
    relevance += scoreTemporalEventTime(inputs.candidate.entry, nowIso);
  }
  return relevance;
}

interface AxisScored {
  readonly candidateKey: string;
  readonly entry: Readonly<MemoryEntry>;
  readonly score: number;
}

// Clone of buildFusionRanksForStream over a collapsed R_a: filter R_a>0, sort desc with the deterministic
// compareMemoryEntries tie-break, 1-based rank. A filtered candidate gets no vote on that axis.
export function buildAxisRanks(scored: readonly AxisScored[]): ReadonlyMap<string, number> {
  const ranked = scored
    .filter((entry) => entry.score > 0)
    .slice()
    .sort((left, right) =>
      right.score === left.score
        ? compareMemoryEntries(left.entry, right.entry)
        : right.score - left.score
    );
  return new Map(ranked.map((entry, index) => [entry.candidateKey, index + 1] as const));
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

interface CollapsedCandidate {
  readonly candidateKey: string;
  readonly entry: Readonly<MemoryEntry>;
  readonly object: number;
  readonly path: number;
  readonly evidence: number;
}

// Pool-level three-pass: (1) collapse R_O/R_P/R_E per candidate; (2) rank per axis; (3) cross-axis RRF + cap.
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
  const collapsed: CollapsedCandidate[] = params.candidates.map(({ candidateKey, candidate }) => {
    const inputs: CollapseInputs = {
      candidate,
      candidateKey,
      scoresByStream: params.scoresByStream,
      resolved: params.resolved,
      supplementaryData: params.supplementaryData
    };
    return {
      candidateKey,
      entry: candidate.entry,
      object: quantize(
        collapseObjectRelevance(inputs, params.embeddingPoolMax, params.queryWindow, params.intent, lambda, gateFloor)
      ),
      path: quantize(collapsePathRelevance(inputs)),
      evidence: quantize(collapseEvidenceRelevance(inputs, params.nowIso, lambda))
    };
  });

  const ranksByAxis: Record<RecallConformantAxis, ReadonlyMap<string, number>> = {
    object: buildAxisRanks(collapsed.map((c) => ({ candidateKey: c.candidateKey, entry: c.entry, score: c.object }))),
    path: buildAxisRanks(collapsed.map((c) => ({ candidateKey: c.candidateKey, entry: c.entry, score: c.path }))),
    evidence: buildAxisRanks(collapsed.map((c) => ({ candidateKey: c.candidateKey, entry: c.entry, score: c.evidence })))
  };

  return assembleConformantScores(collapsed, ranksByAxis);
}

function assembleConformantScores(
  collapsed: readonly CollapsedCandidate[],
  ranksByAxis: Record<RecallConformantAxis, ReadonlyMap<string, number>>
): ConformantAxisContext {
  const weights = resolveConformantWeights();
  const kByAxis: Record<RecallConformantAxis, number> = {
    object: resolveConformantAxisK("object"),
    path: resolveConformantAxisK("path"),
    evidence: resolveConformantAxisK("evidence")
  };
  const scale = resolveConformantScale();
  const scoreByKey = new Map<string, number>();
  const axisRankByKey = new Map<string, Readonly<Record<RecallConformantAxis, number | null>>>();
  const raByKey = new Map<string, Readonly<Record<RecallConformantAxis, number>>>();

  for (const candidate of collapsed) {
    const rankObject = ranksByAxis.object.get(candidate.candidateKey) ?? null;
    const rankPath = ranksByAxis.path.get(candidate.candidateKey) ?? null;
    const rankEvidence = ranksByAxis.evidence.get(candidate.candidateKey) ?? null;
    const rhoObject = rankObject === null ? 0 : 1 / (kByAxis.object + rankObject);
    const rhoPath = rankPath === null ? 0 : 1 / (kByAxis.path + rankPath);
    const rhoEvidence = rankEvidence === null ? 0 : 1 / (kByAxis.evidence + rankEvidence);
    const objectVote = weights.object * rhoObject;
    const orthogonalSum = weights.path * rhoPath + weights.evidence * rhoEvidence;
    const sRaw = applyConformantGovernance(objectVote, orthogonalSum) + orthogonalSum;
    scoreByKey.set(candidate.candidateKey, scale * sRaw);
    axisRankByKey.set(
      candidate.candidateKey,
      Object.freeze({ object: rankObject, path: rankPath, evidence: rankEvidence })
    );
    raByKey.set(
      candidate.candidateKey,
      Object.freeze({ object: candidate.object, path: candidate.path, evidence: candidate.evidence })
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
