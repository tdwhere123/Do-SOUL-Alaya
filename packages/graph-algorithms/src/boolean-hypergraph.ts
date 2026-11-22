import { solveBottleneckHypergraph } from "./bottleneck-hypergraph.js";

export type BooleanHyperedge =
  | UnaryBooleanEdge
  | AndBooleanHyperedge
  | OrBooleanHyperedge
  | IdentityBooleanEdge;

interface UnaryBooleanEdge {
  readonly kind: "unary";
  readonly from: string;
  readonly to: string;
  readonly strength: number;
}

interface AndBooleanHyperedge {
  readonly kind: "and";
  readonly from: readonly string[];
  readonly to: string;
  readonly strength: number;
}

interface OrBooleanHyperedge {
  readonly kind: "or";
  readonly from: readonly string[];
  readonly to: string;
  readonly strength: number;
}

interface IdentityBooleanEdge {
  readonly kind: "identity";
  readonly from: string;
  readonly to: string;
}

export interface BooleanHypergraphInput {
  readonly nodeIds: readonly string[];
  readonly seeds: ReadonlyMap<string, number>;
  readonly edges: readonly BooleanHyperedge[];
  readonly bottom: 0;
  readonly top: number;
}

/** Single-pass best-first bottleneck settlement. Absent keys are unreachable, not a default 0. */
export function evaluateBooleanHypergraph(
  input: BooleanHypergraphInput
): ReadonlyMap<string, number> {
  const top = requireIntegerTop(input.top, input.bottom);
  return solveBottleneckHypergraph({
    nodeIds: input.nodeIds,
    seeds: input.seeds,
    edges: input.edges,
    bottom: input.bottom,
    top
  }).values;
}

function requireIntegerTop(top: number, bottom: 0): number {
  if (bottom !== 0 || !Number.isInteger(top) || top < 0) {
    throw new Error("boolean hypergraph top must be a nonnegative integer with bottom 0");
  }
  return top;
}
