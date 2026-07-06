import { noisyOrDecorrelate } from "./conformant-evidence-math.js";
import {
  resolveFusionContribution as resolveAdaptiveFusionContribution,
  type FusionContributionCandidate,
  type ResolvedRecallFusionWeights
} from "../delivery/fusion-delivery-adaptive-scoring.js";
import { scoreTemporalFusion } from "../delivery/fusion-delivery-scoring-streams.js";
import type {
  PathInflowEdge,
  RecallConformantAxis,
  RecallFusionStream,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import {
  readRecallFloat,
  readRecallUnitFloat
} from "../../config/recall-env-access.js";

export const CONFORMANT_AXES: readonly RecallConformantAxis[] = [
  "object",
  "path",
  "evidence",
  "temporal",
  "control"
];

const RA_QUANTUM = 1e-9;
const EVIDENCE_DECAY = 1;

function readUnitEnv(name: string, fallback: number): number {
  return readRecallUnitFloat(name, fallback);
}

function readFloatEnv(name: string, fallback: number, min: number): number {
  return readRecallFloat(name, fallback, min);
}

export function resolveConformantRhoPath(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_RHO_PATH", 0.5);
}

export function resolveConformantRhoEvidence(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_RHO_EVIDENCE", 0.5);
}

export function resolveConformantPathWeight(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_W_PATH", 0.6, 0);
}

export function resolveConformantEvidenceBeta(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_EVIDENCE_BETA", 0, 0);
}

export function resolveConformantFloodCapPerSource(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_FLOOD_CAP", 1, 0);
}

export function resolveConformantFloodCapTotal(): number {
  return readFloatEnv("ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL", 3, 0);
}

function quantize(value: number): number {
  return Math.round(value / RA_QUANTUM) * RA_QUANTUM;
}

type EvidenceCollapseInputs = Readonly<{
  readonly candidate: FusionContributionCandidate;
  readonly supplementaryData: RecallSupplementaryData;
}>;

function independentSupportValues(inputs: EvidenceCollapseInputs): readonly number[] {
  const objectId = inputs.candidate.entry.object_id;
  const vector = inputs.supplementaryData.evidenceSupportVectorsByMemoryId?.[objectId];
  return vector?.map((support) => Math.max(0, support.support)).filter((support) => support > 0) ?? [];
}

// R_E = decay_ev · NOR_ρ(independent evidence-source support). No stream supports — lexical /
// evidence_fts views stay in R_lex; scalar graphSupportCounts stays out of the evidence axis.
export function collapseEvidenceRelevance(inputs: EvidenceCollapseInputs, rhoEvidence: number): number {
  const support = independentSupportValues(inputs);
  return EVIDENCE_DECAY * noisyOrDecorrelate(support, support.map(() => 1), rhoEvidence);
}

export interface ConformantCandidate {
  readonly candidateKey: string;
  readonly candidate: FusionContributionCandidate;
}

export interface ConformantAxisContext {
  readonly axisRankByKey: ReadonlyMap<string, Readonly<Record<RecallConformantAxis, number | null>>>;
  readonly raByKey: ReadonlyMap<string, Readonly<Record<RecallConformantAxis, number>>>;
}

const NULL_AXIS_RANK: Readonly<Record<RecallConformantAxis, number | null>> =
  Object.freeze({ object: null, path: null, evidence: null, temporal: null, control: null });

// R_O := RRF_base = Σ active-stream RRF contributions — the proven additive object ranking. The flood
// seeds from this same base (B1: one scale across the delivered base and the path inflow).
function resolveObjectBase(
  candidate: FusionContributionCandidate,
  candidateKey: string,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  resolved: ResolvedRecallFusionWeights,
  supplementaryData: RecallSupplementaryData
): number {
  let base = 0;
  for (const [stream, rankByKey] of ranksByStream) {
    const rank = rankByKey.get(candidateKey);
    if (rank !== undefined) {
      base += resolveAdaptiveFusionContribution({ candidate, supplementaryData, resolved, stream, rank });
    }
  }
  return base;
}

// Φ(o) = min(NOR_{ρ_path}({min(R_O(s)·π, cap_src) : e=(s→o), s≠o}), cap_tot). Self-loops and π=0
// co-occurrence edges carry no flood; the NOR fold keeps the total bounded in [0,1] before the cap_tot clamp.
export function collapsePathInflow(
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

// Per-candidate axis magnitudes: object base R_O (RRF_base), path inflow Φ (verified answers_with
// edges, RRF_base seed), evidence R_E (inbound graph support). raByKey is the R_a tie-break vector.
export function buildConformantAxisContext(params: Readonly<{
  readonly candidates: readonly ConformantCandidate[];
  readonly ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly supplementaryData: RecallSupplementaryData;
  readonly nowIso: string;
}>): ConformantAxisContext {
  const rhoEvidence = resolveConformantRhoEvidence();
  const rhoPath = resolveConformantRhoPath();
  const capPerSource = resolveConformantFloodCapPerSource();
  const capTotal = resolveConformantFloodCapTotal();
  const seeded = params.candidates.map(({ candidateKey, candidate }) => ({
    candidateKey,
    objectId: candidate.entry.object_id,
    object: resolveObjectBase(candidate, candidateKey, params.ranksByStream, params.resolved, params.supplementaryData),
    evidence: quantize(
      collapseEvidenceRelevance(
        { candidate, supplementaryData: params.supplementaryData },
        rhoEvidence
      )
    ),
    temporal: quantize(scoreTemporalFusion(candidate.entry, params.supplementaryData.queryProbes, params.nowIso)),
    control: quantize(scoreControlAxis(candidate))
  }));
  const rObjectById = new Map<string, number>();
  for (const candidate of seeded) {
    rObjectById.set(candidate.objectId, Math.max(rObjectById.get(candidate.objectId) ?? 0, candidate.object));
  }
  const inflowByTarget = params.supplementaryData.pathInflowByTarget;
  const axisRankByKey = new Map<string, Readonly<Record<RecallConformantAxis, number | null>>>();
  const raByKey = new Map<string, Readonly<Record<RecallConformantAxis, number>>>();
  for (const candidate of seeded) {
    const flood = quantize(
      collapsePathInflow(inflowByTarget?.[candidate.objectId], candidate.objectId, rObjectById, capPerSource, capTotal, rhoPath)
    );
    axisRankByKey.set(candidate.candidateKey, NULL_AXIS_RANK);
    raByKey.set(
      candidate.candidateKey,
      Object.freeze({
        object: candidate.object,
        path: flood,
        evidence: candidate.evidence,
        temporal: candidate.temporal,
        control: candidate.control
      })
    );
  }
  return Object.freeze({ axisRankByKey, raByKey });
}

function scoreControlAxis(candidate: FusionContributionCandidate): number {
  const manifestation = candidate.entry.manifestation_state;
  const visibility =
    manifestation === "full_eligible" ? 1 :
    manifestation === "excerpt" ? 0.75 :
    manifestation === "hint" ? 0.35 :
    manifestation === "hidden" ? 0.05 :
    0.5;
  return Math.max(0, visibility * Math.max(0, candidate.entry.confidence ?? 0.5));
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
