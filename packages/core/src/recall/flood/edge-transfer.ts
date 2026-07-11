import { noisyOrDecorrelate } from "../scoring/conformant-evidence-math.js";
import type {
  PathInflowEdge,
  RecallFloodEdgeTraceV1
} from "../runtime/recall-service-types.js";
import type { SliceCompatibilityV1 } from "./slice-key-selector.js";
import { evaluateSingleHopRemoteness } from "./remoteness.js";
import { clamp01 } from "../../shared/clamp.js";

export const RECALL_FLOOD_EDGE_TRACE_LIMIT = 16;

export interface FloodEdgeTransferResult {
  readonly value: number;
  readonly traces: readonly Readonly<RecallFloodEdgeTraceV1>[];
  readonly truncatedCount: number;
}

type FloodEdgeTransferInput = Readonly<{
  readonly inflow: readonly PathInflowEdge[] | undefined;
  readonly targetObjectId: string;
  readonly rObjectById: ReadonlyMap<string, number>;
  readonly capPerSource: number;
  readonly capTotal: number;
  readonly rhoPath: number;
  readonly traceLimit?: number;
  readonly sliceCompatibilityByPathId?: ReadonlyMap<string, Readonly<SliceCompatibilityV1>>;
  readonly enforceSliceCompatibility?: boolean;
}>;

function traceForEdge(
  edge: PathInflowEdge,
  targetObjectId: string,
  inputPotential: number,
  capPerSource: number,
  sliceCompatibility: Readonly<SliceCompatibilityV1> | undefined,
  enforceSliceCompatibility: boolean
): Readonly<RecallFloodEdgeTraceV1> {
  const tracePotential = enforceSliceCompatibility ? clamp01(inputPotential) : inputPotential;
  const traceConductance = enforceSliceCompatibility ? clamp01(edge.weight) : edge.weight;
  const remoteness = evaluateSingleHopRemoteness({
    inputPotential: tracePotential,
    edgeConductance: traceConductance,
    capPerSource,
    selfLoop: edge.seedObjectId === targetObjectId,
    sliceCompatibility,
    enforceSliceCompatibility,
    edgeProvenanceValid: hasValidSliceProvenance(edge)
  });
  return Object.freeze({
    schema_version: 1,
    path_id: edge.pathId ?? `unknown:${edge.seedObjectId}->${targetObjectId}`,
    relation_kind: edge.relationKind ?? "unknown",
    seed_object_id: edge.seedObjectId,
    target_object_id: edge.targetObjectId ?? targetObjectId,
    input_potential: tracePotential,
    edge_conductance: traceConductance,
    slice_compatibility: remoteness.sliceCompatibility,
    raw_transfer: remoteness.rawTransfer,
    capped_transfer: remoteness.cappedTransfer,
    decision: remoteness.decision,
    reason: remoteness.reason
  });
}

function hasValidSliceProvenance(edge: Readonly<PathInflowEdge>): boolean {
  return hasText(edge.pathId) &&
    edge.seedAnchor !== undefined && edge.seedAnchor !== null &&
    edge.targetAnchor !== undefined && edge.targetAnchor !== null &&
    hasText(edge.pathSourceVersion);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compareTrace(
  left: Readonly<RecallFloodEdgeTraceV1>,
  right: Readonly<RecallFloodEdgeTraceV1>
): number {
  const decisionOrder = compareDecision(left, right);
  if (decisionOrder !== 0) return decisionOrder;
  if (left.decision === "rejected" && right.decision === "rejected") {
    const reasonOrder = rejectionReasonPriority(left.reason) - rejectionReasonPriority(right.reason);
    if (reasonOrder !== 0) return reasonOrder;
    const rawOrder = compareNumberDescending(left.raw_transfer, right.raw_transfer);
    if (rawOrder !== 0) return rawOrder;
  } else {
    const cappedOrder = compareNumberDescending(left.capped_transfer, right.capped_transfer);
    if (cappedOrder !== 0) return cappedOrder;
    const rawOrder = compareNumberDescending(left.raw_transfer, right.raw_transfer);
    if (rawOrder !== 0) return rawOrder;
  }
  return compareText(left.path_id, right.path_id) ||
    compareText(left.seed_object_id, right.seed_object_id) ||
    compareText(left.target_object_id, right.target_object_id) ||
    compareText(left.relation_kind, right.relation_kind);
}

function compareDecision(
  left: Readonly<RecallFloodEdgeTraceV1>,
  right: Readonly<RecallFloodEdgeTraceV1>
): number {
  if (left.decision === right.decision) return 0;
  return left.decision === "rejected" ? -1 : 1;
}

function rejectionReasonPriority(reason: RecallFloodEdgeTraceV1["reason"]): number {
  switch (reason) {
    case "no_slice_match": return 0;
    case "missing_edge_provenance": return 1;
    case "self_loop": return 2;
    case "capped": return 3;
    case "non_positive_conductance": return 4;
    case "missing_or_zero_input": return 5;
    case "transferred": return 6;
  }
}

function compareNumberDescending(left: number, right: number): number {
  if (left === right || Object.is(left, right)) return 0;
  if (Number.isNaN(left)) return 1;
  if (Number.isNaN(right)) return -1;
  return left > right ? -1 : 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function computeFloodEdgeTransfer(
  input: FloodEdgeTransferInput
): Readonly<FloodEdgeTransferResult> {
  const supports: number[] = [];
  const traces: Readonly<RecallFloodEdgeTraceV1>[] = [];
  for (const edge of input.inflow ?? []) {
    const inputPotential = input.rObjectById.get(edge.seedObjectId) ?? 0;
    const sliceCompatibility = edge.pathId === undefined
      ? undefined
      : input.sliceCompatibilityByPathId?.get(edge.pathId);
    const trace = traceForEdge(
      edge,
      input.targetObjectId,
      inputPotential,
      input.capPerSource,
      sliceCompatibility,
      input.enforceSliceCompatibility === true
    );
    traces.push(trace);
    if (trace.decision === "transferred") {
      supports.push(trace.capped_transfer);
    }
  }
  const limit = Math.max(0, Math.trunc(input.traceLimit ?? RECALL_FLOOD_EDGE_TRACE_LIMIT));
  const ordered = traces.sort(compareTrace);
  const value = Math.min(
    noisyOrDecorrelate(supports, supports.map(() => 1), input.rhoPath),
    clamp01(input.capTotal)
  );
  return Object.freeze({
    value,
    traces: Object.freeze(ordered.slice(0, limit)),
    truncatedCount: Math.max(0, ordered.length - limit)
  });
}
