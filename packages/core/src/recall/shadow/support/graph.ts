import { compareText } from "../../../shared/compare-text.js";
import { ShadowContractError } from "../envelope.js";
import type { BindingRelationWitness, CorrelationWitness } from "../witness/index.js";
import {
  createBindingRelationWitness,
  createCorrelationWitness,
  meetBindingRelation,
  meetCorrelation
} from "../witness/index.js";
import { nodeKey, parseQueryPin } from "./identity.js";
import { aliasRecord, correlationRecord, parseEdge, parseNode } from "./records.js";
import { digestSupportHypergraph, type SupportHypergraphReceiptV1 } from
  "./receipt.js";
import type {
  SupportAliasRecordV1,
  SupportCorrelationRecordV1,
  SupportEdgeV1,
  SupportNodeV1
} from "./types.js";

export type SupportHypergraphInputV1 = Readonly<{
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly nodes?: readonly unknown[];
  readonly edges?: readonly unknown[];
  readonly aliases?: readonly BindingRelationWitness[];
  readonly correlations?: readonly CorrelationWitness[];
}>;

export function createSupportHypergraph(
  input: SupportHypergraphInputV1
): SupportHypergraphReceiptV1 {
  const queryId = parseQueryPin(input.query_id, "query_id");
  const snapshot = parseQueryPin(input.snapshot_digest, "snapshot_digest");
  const nodes = uniqueNodes(input.nodes ?? []);
  const nodeIndex = indexNodes(nodes);
  const edges = uniqueEdges(input.edges ?? [], nodeIndex);
  const aliases = uniqueAliases(input.aliases ?? [], nodeIndex, queryId, snapshot);
  const correlations = uniqueCorrelations(
    input.correlations ?? [],
    edges,
    nodeIndex,
    queryId,
    snapshot
  );
  return digestSupportHypergraph({
    query_id: queryId,
    snapshot_digest: snapshot,
    nodes,
    edges,
    aliases,
    correlations
  });
}

function uniqueNodes(inputs: readonly unknown[]): readonly SupportNodeV1[] {
  const seen = new Map<string, SupportNodeV1>();
  for (const input of inputs) {
    const node = parseNode(input);
    seen.set(nodeKey(node.kind, node.id), node);
  }
  return Object.freeze([...seen.values()].sort(compareNodes));
}

function uniqueEdges(
  inputs: readonly unknown[],
  nodes: ReadonlyMap<string, SupportNodeV1>
): readonly SupportEdgeV1[] {
  const seen = new Map<string, SupportEdgeV1>();
  for (const input of inputs) {
    const edge = parseEdge(input);
    assertEndpoint(nodes, edge.from);
    assertEndpoint(nodes, edge.to);
    seen.set(edgeKey(edge), edge);
  }
  return Object.freeze([...seen.values()].sort(compareEdges));
}

function uniqueAliases(
  inputs: readonly BindingRelationWitness[],
  nodes: ReadonlyMap<string, SupportNodeV1>,
  queryId: string,
  snapshot: string
): readonly SupportAliasRecordV1[] {
  const merged = new Map<string, BindingRelationWitness>();
  for (const witness of inputs) {
    assertWitnessPins(witness.identity, queryId, snapshot, "alias");
    const canonical = canonicalizeAlias(witness);
    const record = aliasRecord(canonical);
    assertBinding(nodes, record.left_id);
    assertBinding(nodes, record.right_id);
    const key = pairKey(record.left_id, record.right_id);
    const previous = merged.get(key);
    merged.set(
      key,
      previous === undefined ? canonical : meetBindingRelation(previous, canonical)
    );
  }
  return Object.freeze([...merged.values()].map(aliasRecord).sort(comparePairs));
}

function uniqueCorrelations(
  inputs: readonly CorrelationWitness[],
  edges: readonly SupportEdgeV1[],
  nodes: ReadonlyMap<string, SupportNodeV1>,
  queryId: string,
  snapshot: string
): readonly SupportCorrelationRecordV1[] {
  const fromWitnesses = new Map<string, CorrelationWitness>();
  for (const witness of inputs) {
    assertWitnessPins(witness.identity, queryId, snapshot, "correlation");
    const canonical = canonicalizeCorrelation(witness);
    const record = correlationRecord(canonical);
    assertEvidence(nodes, record.left_id);
    assertEvidence(nodes, record.right_id);
    const key = pairKey(record.left_id, record.right_id);
    const previous = fromWitnesses.get(key);
    fromWitnesses.set(
      key,
      previous === undefined ? canonical : meetCorrelation(previous, canonical)
    );
  }
  return Object.freeze(correlatedRecords(edges, fromWitnesses, queryId, snapshot).sort(comparePairs));
}

function correlatedRecords(
  edges: readonly SupportEdgeV1[],
  witnesses: ReadonlyMap<string, CorrelationWitness>,
  queryId: string,
  snapshot: string
): SupportCorrelationRecordV1[] {
  const records: SupportCorrelationRecordV1[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "correlated") continue;
    const key = pairKey(edge.from.id, edge.to.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const witness = witnesses.get(key) ?? defaultCorrelation(edge, queryId, snapshot);
    records.push(correlationRecord(witness));
  }
  for (const key of witnesses.keys()) {
    if (seen.has(key)) continue;
    throw new ShadowContractError("correlation witness requires a correlated edge");
  }
  return records;
}

function canonicalizeAlias(witness: BindingRelationWitness): BindingRelationWitness {
  const record = aliasRecord(witness);
  return createBindingRelationWitness({
    identity: witness.identity,
    provenance: witness.provenance,
    epistemic: witness.epistemic,
    payload: {
      left_id: record.left_id,
      right_id: record.right_id,
      state: record.state
    }
  });
}

function canonicalizeCorrelation(witness: CorrelationWitness): CorrelationWitness {
  const record = correlationRecord(witness);
  return createCorrelationWitness({
    identity: witness.identity,
    provenance: witness.provenance,
    epistemic: witness.epistemic,
    payload: {
      left_id: record.left_id,
      right_id: record.right_id,
      state: record.state
    }
  });
}

function defaultCorrelation(
  edge: SupportEdgeV1,
  queryId: string,
  snapshot: string
): CorrelationWitness {
  return createCorrelationWitness({
    identity: {
      coordinate_id: "support.correlation.default",
      query_id: queryId,
      snapshot_digest: snapshot
    },
    provenance: [{ source_id: "support.graph", producer: "support.hypergraph.v1" }],
    epistemic: { kind: "exact" },
    payload: {
      left_id: edge.from.id,
      right_id: edge.to.id,
      state: "possibly_correlated"
    }
  });
}

function indexNodes(
  nodes: readonly SupportNodeV1[]
): ReadonlyMap<string, SupportNodeV1> {
  return new Map(nodes.map((node) => [nodeKey(node.kind, node.id), node]));
}

function assertEndpoint(
  nodes: ReadonlyMap<string, SupportNodeV1>,
  endpoint: SupportEdgeV1["from"]
): void {
  if (!nodes.has(nodeKey(endpoint.kind, endpoint.id))) {
    throw new ShadowContractError("edge endpoint is missing from the node set");
  }
}

function assertBinding(nodes: ReadonlyMap<string, SupportNodeV1>, id: string): void {
  if (!nodes.has(nodeKey("answer_binding", id))) {
    throw new ShadowContractError("alias pair must name answer_binding nodes");
  }
}

function assertEvidence(nodes: ReadonlyMap<string, SupportNodeV1>, id: string): void {
  if (!nodes.has(nodeKey("evidence_unit", id))) {
    throw new ShadowContractError("correlation pair must name evidence_unit nodes");
  }
}

function assertWitnessPins(
  identity: BindingRelationWitness["identity"],
  queryId: string,
  snapshot: string,
  label: string
): void {
  if (identity.query_id !== queryId || identity.snapshot_digest !== snapshot) {
    throw new ShadowContractError(`${label} witness identity pins must match the graph`);
  }
}

function edgeKey(edge: SupportEdgeV1): string {
  return [edge.kind, edge.from.kind, edge.from.id, edge.to.kind, edge.to.id].join("\0");
}

function pairKey(left: string, right: string): string {
  return left <= right ? `${left}\0${right}` : `${right}\0${left}`;
}

function compareNodes(left: SupportNodeV1, right: SupportNodeV1): number {
  return compareText(left.kind, right.kind) || compareText(left.id, right.id);
}

function compareEdges(left: SupportEdgeV1, right: SupportEdgeV1): number {
  return compareText(edgeKey(left), edgeKey(right));
}

function comparePairs(
  left: { readonly left_id: string; readonly right_id: string },
  right: { readonly left_id: string; readonly right_id: string }
): number {
  return compareText(pairKey(left.left_id, left.right_id), pairKey(right.left_id, right.right_id));
}
