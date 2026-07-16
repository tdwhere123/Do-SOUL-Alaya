import type { MemoryEntry } from "@do-soul/alaya-protocol";

import { noisyOrDecorrelate } from "./conformant-evidence-math.js";
import { computeFloodEdgeTransfer } from "../flood/edge-transfer.js";
import {
  deriveMemorySliceKeysV1,
  derivePathAnchorSliceKeysV1,
  deriveQuerySliceKeysV1,
  selectSliceCompatibilityV1
} from "../flood/slice-key-selector.js";
import type {
  SliceCompatibilityV1
} from "../flood/slice-key-selector.js";
import type { SelectedSliceKeyV1 } from "../flood/slice-key-contract.js";
import {
  resolveFusionContribution as resolveAdaptiveFusionContribution,
  type FusionContributionCandidate,
  type ResolvedRecallFusionWeights
} from "../delivery/fusion-delivery-adaptive-scoring.js";
import { aggregateFamilyContributions } from "../delivery/fusion-delivery-families.js";
import { scoreTemporalFusion } from "../delivery/fusion-delivery-scoring-streams.js";
import type {
  PathInflowEdge,
  RecallConformantAxis,
  RecallFusionStream,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import type { RecallFloodEdgeTraceV1 } from "../runtime/recall-service-types.js";
import { isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import {
  recallEnvFlagEnabled,
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

export function resolveConformantRhoPath(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_RHO_PATH", 0.5);
}

export function resolveConformantRhoEvidence(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_RHO_EVIDENCE", 0.5);
}

export function resolveConformantPathWeight(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_W_PATH", 0.6);
}

export function resolveConformantEvidenceBeta(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_EVIDENCE_BETA", 0);
}

export function resolveConformantFloodCapPerSource(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_FLOOD_CAP", 1);
}

export function resolveConformantFloodCapTotal(): number {
  return readUnitEnv("ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL", 1);
}

function quantize(value: number): number {
  return Math.round(value / RA_QUANTUM) * RA_QUANTUM;
}

type EvidenceCollapseInputs = Readonly<{
  readonly candidate: FusionContributionCandidate;
  readonly supplementaryData: RecallSupplementaryData;
}>;

function independentSupportValues(inputs: EvidenceCollapseInputs): readonly number[] {
  if (!isWorkspaceMemoryCandidate(inputs.candidate)) return [];
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
  readonly objectBase?: number;
}

export interface ConformantAxisContext {
  readonly axisRankByKey: ReadonlyMap<string, Readonly<Record<RecallConformantAxis, number | null>>>;
  readonly raByKey: ReadonlyMap<string, Readonly<Record<RecallConformantAxis, number>>>;
  readonly edgeTraceByKey: ReadonlyMap<string, Readonly<FloodEdgeTraceBundle>>;
}

interface FloodEdgeTraceBundle {
  readonly traces: readonly Readonly<RecallFloodEdgeTraceV1>[];
  readonly truncatedCount: number;
}

interface SeededConformantCandidate {
  readonly candidateKey: string;
  readonly objectId: string;
  readonly entry: Readonly<MemoryEntry>;
  readonly memorySupplementEligible: boolean;
  readonly object: number;
  readonly evidence: number;
  readonly temporal: number;
  readonly control: number;
}

interface SliceSelectionContext {
  readonly queryKeysByWorkspace: ReadonlyMap<string, readonly SelectedSliceKeyV1[]>;
  readonly memoryKeysByWorkspaceObject: ReadonlyMap<string, readonly SelectedSliceKeyV1[]>;
  readonly asOfMs: number;
}

const EMPTY_SLICE_KEYS: readonly SelectedSliceKeyV1[] = Object.freeze([]);

const NULL_AXIS_RANK: Readonly<Record<RecallConformantAxis, number | null>> =
  Object.freeze({ object: null, path: null, evidence: null, temporal: null, control: null });

// R_O := family-decorrelated RRF_base (Σ max lane contribution per family). The flood
// seeds from this same base (B1: one scale across the delivered base and the path inflow).
function resolveObjectBase(
  input: ConformantCandidate,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  resolved: ResolvedRecallFusionWeights,
  supplementaryData: RecallSupplementaryData
): number {
  if (input.objectBase !== undefined) {
    return input.objectBase;
  }
  const contributions = {} as Record<RecallFusionStream, number>;
  for (const [stream, rankByKey] of ranksByStream) {
    const rank = rankByKey.get(input.candidateKey);
    if (rank !== undefined) {
      contributions[stream] = resolveAdaptiveFusionContribution({
        candidate: input.candidate,
        supplementaryData,
        resolved,
        stream,
        rank
      });
    }
  }
  return aggregateFamilyContributions(contributions);
}

// invariant: parallel eligible edges remain distinct inputs to the NOR fold.
export function collapsePathInflow(
  inflow: readonly PathInflowEdge[] | undefined,
  targetObjectId: string,
  rObjectById: ReadonlyMap<string, number>,
  capPerSource: number,
  capTotal: number,
  rhoPath: number
): number {
  return computeFloodEdgeTransfer({
    inflow,
    targetObjectId,
    rObjectById,
    capPerSource,
    capTotal,
    rhoPath,
    traceLimit: 0
  }).value;
}

// Per-candidate axis magnitudes: object base R_O (RRF_base), path inflow Φ (verified answers_with
// edges, RRF_base seed), evidence R_E (inbound graph support). raByKey is the R_a tie-break vector.
export function buildConformantAxisContext(params: Readonly<{
  readonly candidates: readonly ConformantCandidate[];
  readonly ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly supplementaryData: RecallSupplementaryData;
  readonly nowIso: string;
  readonly enforceSliceCompatibility?: boolean;
}>): ConformantAxisContext {
  const rhoEvidence = resolveConformantRhoEvidence();
  const rhoPath = resolveConformantRhoPath();
  const capPerSource = resolveConformantFloodCapPerSource();
  const capTotal = resolveConformantFloodCapTotal();
  const seeded = seedConformantCandidates(params, rhoEvidence);
  const rObjectById = buildObjectPotentialById(seeded);
  const sliceSelection = buildSliceSelectionContext(params);
  const axisRankByKey = new Map<string, Readonly<Record<RecallConformantAxis, number | null>>>();
  const raByKey = new Map<string, Readonly<Record<RecallConformantAxis, number>>>();
  const edgeTraceByKey = new Map<string, Readonly<FloodEdgeTraceBundle>>();
  const enforceSliceCompatibility = params.enforceSliceCompatibility
    ?? recallEnvFlagEnabled("ALAYA_RECALL_CONF_SLICE_COMPATIBILITY");
  for (const candidate of seeded) {
    recordCandidateAxes(candidate, rObjectById, params.supplementaryData, {
      rhoPath, capPerSource, capTotal, axisRankByKey, raByKey, edgeTraceByKey,
      sliceSelection, enforceSliceCompatibility
    });
  }
  return Object.freeze({ axisRankByKey, raByKey, edgeTraceByKey });
}

function seedConformantCandidates(
  params: Parameters<typeof buildConformantAxisContext>[0],
  rhoEvidence: number
): readonly SeededConformantCandidate[] {
  return params.candidates.map((input) => {
    const memorySupplementEligible = isWorkspaceMemoryCandidate(input.candidate);
    return {
      candidateKey: input.candidateKey,
      objectId: input.candidate.entry.object_id,
      entry: input.candidate.entry,
      memorySupplementEligible,
      object: resolveObjectBase(
        input,
        params.ranksByStream,
        params.resolved,
        params.supplementaryData
      ),
      evidence: memorySupplementEligible
        ? quantize(collapseEvidenceRelevance({
          candidate: input.candidate,
          supplementaryData: params.supplementaryData
        }, rhoEvidence))
        : 0,
      temporal: quantize(scoreTemporalFusion(
        input.candidate.entry,
        params.supplementaryData.queryProbes,
        params.nowIso
      )),
      control: quantize(scoreControlAxis(input.candidate))
    };
  });
}

function buildSliceSelectionContext(
  params: Parameters<typeof buildConformantAxisContext>[0]
): Readonly<SliceSelectionContext> {
  const queryKeysByWorkspace = new Map<string, readonly SelectedSliceKeyV1[]>();
  const memoryKeysByWorkspaceObject = new Map<string, readonly SelectedSliceKeyV1[]>();
  const parsedAsOfMs = Date.parse(params.nowIso);
  const asOfMs = Number.isSafeInteger(parsedAsOfMs) ? parsedAsOfMs : 0;
  for (const { candidate } of params.candidates) {
    if (!isWorkspaceMemoryCandidate(candidate)) continue;
    const workspaceId = candidate.entry.workspace_id;
    if (!queryKeysByWorkspace.has(workspaceId)) {
      queryKeysByWorkspace.set(workspaceId, deriveQuerySliceKeysV1({
        workspaceId, queryProbes: params.supplementaryData.queryProbes,
        asOfMs, nowIso: params.nowIso
      }));
    }
    memoryKeysByWorkspaceObject.set(memoryProjectionKey(workspaceId, candidate.entry.object_id), deriveMemorySliceKeysV1({
      workspaceId, entry: candidate.entry, asOfMs
    }));
  }
  return Object.freeze({ queryKeysByWorkspace, memoryKeysByWorkspaceObject, asOfMs });
}

function selectCompatibilityByPathId(
  inflow: readonly PathInflowEdge[] | undefined,
  target: Readonly<MemoryEntry>,
  context: Readonly<SliceSelectionContext>
): ReadonlyMap<string, Readonly<SliceCompatibilityV1>> {
  const result = new Map<string, Readonly<SliceCompatibilityV1>>();
  const workspaceId = target.workspace_id;
  const queryKeys = context.queryKeysByWorkspace.get(workspaceId) ?? EMPTY_SLICE_KEYS;
  const targetMemoryKeys = memoryKeysFor(context, workspaceId, target.object_id);
  for (const edge of inflow ?? []) {
    if (edge.pathId === undefined) continue;
    const sourceKeys = mergeSliceKeys(
      memoryKeysFor(context, workspaceId, edge.seedObjectId),
      pathAnchorKeys(edge, "source", workspaceId, context.asOfMs)
    );
    const targetKeys = mergeSliceKeys(
      targetMemoryKeys,
      pathAnchorKeys(edge, "target", workspaceId, context.asOfMs)
    );
    result.set(edge.pathId, selectSliceCompatibilityV1({
      queryKeys,
      sourceKeys,
      targetKeys
    }));
  }
  return result;
}

function memoryProjectionKey(workspaceId: string, objectId: string): string {
  return JSON.stringify([workspaceId, objectId]);
}

function memoryKeysFor(
  context: Readonly<SliceSelectionContext>,
  workspaceId: string,
  objectId: string
): readonly SelectedSliceKeyV1[] {
  return context.memoryKeysByWorkspaceObject.get(memoryProjectionKey(workspaceId, objectId))
    ?? EMPTY_SLICE_KEYS;
}

function pathAnchorKeys(
  edge: Readonly<PathInflowEdge>,
  side: "source" | "target",
  workspaceId: string,
  asOfMs: number
): readonly SelectedSliceKeyV1[] {
  const anchor = side === "source" ? edge.seedAnchor : edge.targetAnchor;
  if (edge.pathId === undefined || edge.pathSourceVersion === undefined || anchor === undefined) {
    return EMPTY_SLICE_KEYS;
  }
  return derivePathAnchorSliceKeysV1({
    workspaceId,
    pathId: edge.pathId,
    side,
    anchor,
    sourceVersion: edge.pathSourceVersion,
    asOfMs
  });
}

function mergeSliceKeys(
  left: readonly SelectedSliceKeyV1[],
  right: readonly SelectedSliceKeyV1[]
): readonly SelectedSliceKeyV1[] {
  if (right.length === 0) return left;
  const byId = new Map(left.map((key) => [key.key_id, key]));
  for (const key of right) byId.set(key.key_id, key);
  return Object.freeze([...byId.values()]);
}

function buildObjectPotentialById(
  candidates: readonly SeededConformantCandidate[]
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.memorySupplementEligible) continue;
    result.set(candidate.objectId, Math.max(result.get(candidate.objectId) ?? 0, candidate.object));
  }
  return result;
}

function recordCandidateAxes(
  candidate: SeededConformantCandidate,
  rObjectById: ReadonlyMap<string, number>,
  supplementaryData: RecallSupplementaryData,
  state: Readonly<{
    rhoPath: number;
    capPerSource: number;
    capTotal: number;
    axisRankByKey: Map<string, Readonly<Record<RecallConformantAxis, number | null>>>;
    raByKey: Map<string, Readonly<Record<RecallConformantAxis, number>>>;
    edgeTraceByKey: Map<string, Readonly<FloodEdgeTraceBundle>>;
    sliceSelection: Readonly<SliceSelectionContext>;
    enforceSliceCompatibility: boolean;
  }>
): void {
  const inflow = candidate.memorySupplementEligible
    ? supplementaryData.pathInflowByTarget?.[candidate.objectId]
    : undefined;
  const sliceCompatibilityByPathId = selectCompatibilityByPathId(
    inflow, candidate.entry, state.sliceSelection
  );
  const transfer = computeFloodEdgeTransfer({
    inflow, targetObjectId: candidate.objectId, rObjectById,
    capPerSource: state.capPerSource, capTotal: state.capTotal, rhoPath: state.rhoPath,
    sliceCompatibilityByPathId,
    enforceSliceCompatibility: state.enforceSliceCompatibility
  });
  state.axisRankByKey.set(candidate.candidateKey, NULL_AXIS_RANK);
  state.raByKey.set(candidate.candidateKey, Object.freeze({
    object: candidate.object, path: quantize(transfer.value), evidence: candidate.evidence,
    temporal: candidate.temporal, control: candidate.control
  }));
  if (inflow !== undefined && inflow.length > 0) {
    state.edgeTraceByKey.set(candidate.candidateKey, Object.freeze({
      traces: transfer.traces, truncatedCount: transfer.truncatedCount
    }));
  }
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
