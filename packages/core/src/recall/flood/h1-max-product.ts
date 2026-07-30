import { clamp01 } from "../../shared/clamp.js";
import type {
  RecallFloodEdgeTraceV1,
  RecallFloodH1TransitionCounts
} from
  "../runtime/recall-service-types.js";
import { RECALL_FLOOD_EDGE_REASONS } from
  "../runtime/recall-service-types.js";
import {
  evaluateFloodEdgeTraces,
  RECALL_FLOOD_EDGE_TRACE_LIMIT,
  type FloodEdgeTransferInput
} from "./edge-transfer.js";

export interface H1MaxProductTransferResult {
  readonly potential: number;
  readonly pathContribution: number;
  readonly strongestTransfer: number;
  readonly winner: Readonly<RecallFloodEdgeTraceV1> | null;
  readonly traces: readonly Readonly<RecallFloodEdgeTraceV1>[];
  readonly truncatedCount: number;
  readonly transitionCounts: Readonly<RecallFloodH1TransitionCounts>;
}

export function computeH1MaxProductTransfer(
  input: FloodEdgeTransferInput & { readonly directPotential: number }
): Readonly<H1MaxProductTransferResult> {
  const evaluated = evaluateFloodEdgeTraces({
    ...input,
    enforceSliceCompatibility: true
  });
  const strongest = evaluated
    .filter((trace) => trace.decision === "transferred")
    .sort(compareTransferredTrace)[0];
  const directPotential = clamp01(input.directPotential);
  const strongestPotential = Math.min(
    clamp01(strongest?.capped_transfer ?? 0),
    clamp01(input.capTotal)
  );
  const winner = strongestPotential > directPotential ? strongest ?? null : null;
  const pathContribution = winner === null ? 0 : strongestPotential;
  const ordered = winner === null
    ? evaluated
    : [winner, ...evaluated.filter((trace) => trace !== winner)];
  const traceLimit = Math.max(
    0,
    Math.trunc(input.traceLimit ?? RECALL_FLOOD_EDGE_TRACE_LIMIT)
  );
  return Object.freeze({
    potential: Math.max(directPotential, strongestPotential),
    pathContribution,
    strongestTransfer: strongestPotential,
    winner,
    traces: Object.freeze(ordered.slice(0, traceLimit)),
    truncatedCount: Math.max(0, ordered.length - traceLimit),
    transitionCounts: summarizeTransitions(evaluated)
  });
}

function summarizeTransitions(
  traces: readonly Readonly<RecallFloodEdgeTraceV1>[]
): Readonly<RecallFloodH1TransitionCounts> {
  const reasonCounts = Object.fromEntries(
    RECALL_FLOOD_EDGE_REASONS.map((reason) => [reason, 0])
  ) as Record<RecallFloodEdgeTraceV1["reason"], number>;
  let seedOverlap = 0;
  let transferred = 0;
  for (const trace of traces) {
    reasonCounts[trace.reason] += 1;
    if (trace.input_potential > 0) seedOverlap += 1;
    if (trace.decision === "transferred") transferred += 1;
  }
  return Object.freeze({
    evaluated_edge_count: traces.length,
    seed_overlap_edge_count: seedOverlap,
    transferred_edge_count: transferred,
    rejected_edge_count: traces.length - transferred,
    reason_counts: Object.freeze(reasonCounts)
  });
}

function compareTransferredTrace(
  left: Readonly<RecallFloodEdgeTraceV1>,
  right: Readonly<RecallFloodEdgeTraceV1>
): number {
  if (left.capped_transfer !== right.capped_transfer) {
    return right.capped_transfer - left.capped_transfer;
  }
  return left.path_id.localeCompare(right.path_id);
}
