import { type QueryCondition } from "@do-soul/alaya-protocol";
import { applySoftConditionFactors } from
  "../../query/condition/hard-soft-masks.js";
import { computeDissipativeEdgeStep } from "../edge-transfer.js";
import {
  assertDissipativeLambda,
  scaleOutgoingTransfers
} from "../../scoring/activation/dissipative-transfer.js";
import type {
  ActivationEdge,
  ActivationGraph,
  ActivationNode,
  ActivationSlicePort
} from "./activation-graph.js";
import { sortedKeys } from "./activation-membership.js";
import { compareText } from "../../../shared/compare-text.js";

export type PreparedTransfer = Readonly<{
  readonly edge: ActivationEdge;
  readonly energy: number;
}>;

export function outgoingEdges(
  nodeId: string,
  graph: ActivationGraph,
  authorized: ReadonlyMap<string, ActivationNode>
): readonly ActivationEdge[] {
  return graph.edges.filter((edge) =>
    edge.from === nodeId && authorized.has(edge.to)
  ).sort(compareEdges);
}

export function channelsOf(edges: readonly ActivationEdge[]): readonly string[] {
  return sortedKeys(new Set(edges.map((edge) => edge.channel)));
}

export function prepareTransfers(input: Readonly<{
  readonly source: ActivationNode;
  readonly available: number;
  readonly edges: readonly ActivationEdge[];
  readonly authorized: ReadonlyMap<string, ActivationNode>;
  readonly graph: ActivationGraph;
  readonly condition: QueryCondition;
  readonly slice?: ActivationSlicePort;
}>): readonly PreparedTransfer[] {
  const viable: ActivationEdge[] = [];
  const raw: number[] = [];
  for (const edge of input.edges) {
    const message = transferableMessage(input, edge);
    if (message <= 0) continue;
    viable.push(edge);
    raw.push(message);
  }
  const scaled = scaleOutgoingTransfers(
    raw,
    input.available,
    rhoFor(input.graph, viable)
  );
  return viable.map((edge, index) => ({
    edge,
    energy: scaled[index] ?? 0
  })).filter((row) => row.energy > 0);
}

function transferableMessage(
  input: Readonly<{
    readonly source: ActivationNode;
    readonly available: number;
    readonly authorized: ReadonlyMap<string, ActivationNode>;
    readonly condition: QueryCondition;
    readonly slice?: ActivationSlicePort;
  }>,
  edge: ActivationEdge
): number {
  const target = input.authorized.get(edge.to);
  if (target === undefined) return 0;
  if (sliceRejected(input.slice, input.source, target, edge.channel)) return 0;
  const adjusted = applySoftConditionFactors({
    lambda: edge.lambda,
    hop_cost: edge.hop_cost,
    node: target,
    condition: input.condition
  });
  return computeDissipativeEdgeStep({
    inputPotential: input.available,
    conductance: assertDissipativeLambda(adjusted.lambda),
    hopCost: adjusted.hop_cost
  });
}

function rhoFor(graph: ActivationGraph, edges: readonly ActivationEdge[]): number {
  const channel = edges[0]?.channel ?? "path";
  const rho = graph.rho_by_channel[channel];
  if (rho === undefined) {
    throw new Error(`missing dissipative rho_c for channel ${channel}`);
  }
  return rho;
}

function sliceRejected(
  slice: ActivationSlicePort | undefined,
  source: ActivationNode,
  target: ActivationNode,
  channel: string
): boolean {
  if (slice === undefined) return false;
  return slice.compatibility({ source, target, channel }) === "rejected";
}

function compareEdges(left: ActivationEdge, right: ActivationEdge): number {
  return compareText(left.to, right.to) ||
    compareText(left.channel, right.channel) ||
    compareText(left.source, right.source);
}
