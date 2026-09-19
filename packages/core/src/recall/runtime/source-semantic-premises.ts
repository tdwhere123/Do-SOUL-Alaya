import {
  interpretationNodeIdentity, sourceSemanticStructuralEdges, sourceSemanticSlotNodeId, SourceSemanticResourceLedger,
  type InterpretationNodeCoordinate, type SourceEvidenceTarget, type SourceSemanticAlignment,
  type SourceSemanticConsumedLeaf, type SourceSemanticInterpretation
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { ObserverReaders, RelationObserverRow, SourceObserverRow } from "../conditional-field/observers/observe.js";

export function sourceSemanticRelationKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(["source-interpretation-v3", ...parts]);
}
export type SourceSemanticPremisePopulation = Readonly<{
  nodes: ReadonlyMap<string, SourceObserverRow>;
  rows: readonly RelationObserverRow[];
  coordinates: ReadonlyMap<string, InterpretationNodeCoordinate>;
  adjacency: ReadonlyMap<string, RelationObserverRow[]>;
  positions: ReadonlyMap<string, number>;
  origins: ReadonlyMap<string, SourceSemanticConsumedLeaf>;
  work: number;
  bytes: number;
}>;
type Input = Readonly<{
  interpretation: SourceSemanticInterpretation; alignment: SourceSemanticAlignment;
  context_id: string; interpretation_id: string; scope: string; source_target: SourceEvidenceTarget;
  meter: SourceSemanticResourceLedger;
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
}>;

/** H forms bindings independently; A supplies endpoint-bound adapters, not answer seeds. */
export function compileSourceSemanticPremises(input: Input): SourceSemanticPremisePopulation {
  const { meter, interpretation: h } = input;
  const workBefore = meter.spentWork, bytesBefore = meter.spentBytes;
  meter.retain(h, "premise preparation");
  const builder = new PremiseBuilder(input);
  for (const row of [...h.referents, ...h.frames, ...h.operators]) builder.node(row.id);
  for (const [fi, frame] of h.frames.entries()) for (const [si, slot] of frame.slots.entries()) {
    const id = sourceSemanticSlotNodeId(fi, si);
    builder.slotNodes.set(JSON.stringify([frame.id, slot.id]), id); builder.node(id);
  }
  populateOccurrences(builder, h); populateStructure(builder, h); populateBindings(builder, h);
  populateAlignment(builder, input.alignment);
  return { nodes: builder.nodes, rows: builder.rows, coordinates: builder.coordinates,
    adjacency: builder.adjacency, positions: builder.positions, origins: builder.origins,
    work: meter.spentWork - workBefore, bytes: meter.spentBytes - bytesBefore };
}

class PremiseBuilder {
  readonly nodes = new Map<string, SourceObserverRow>();
  readonly coordinates = new Map<string, InterpretationNodeCoordinate>();
  readonly rows: RelationObserverRow[] = [];
  readonly adjacency = new Map<string, RelationObserverRow[]>();
  readonly positions = new Map<string, number>();
  readonly origins = new Map<string, SourceSemanticConsumedLeaf>();
  readonly slotNodes = new Map<string, string>();
  constructor(readonly input: Input) {}
  node(id: string): void {
    this.input.meter.charge(1, 1024, "premise node");
    const coordinate = { packet_id: this.input.interpretation_id, hypothesis_id: this.input.context_id, node_id: id };
    const objectId = interpretationNodeIdentity(coordinate);
    this.coordinates.set(id, coordinate);
    this.nodes.set(objectId, { object_id: objectId, sourceRevision: this.input.interpretation_id,
      target: this.input.source_target, interpretation_node: coordinate, lifecycle_state: "active",
      scope_class: this.input.scope, ...this.input.sourceValidity });
  }
  edge(from: string, to: string, predicate: string, leaf?: SourceSemanticConsumedLeaf): void {
    const source = this.coordinates.get(from), target = this.coordinates.get(to);
    if (source === undefined || target === undefined) throw new CoreError("OBLIGATION_VIOLATION", "premise endpoint is absent");
    this.input.meter.charge(1, 2048 + 4 * predicate.length, "premise edge");
    const row: RelationObserverRow = {
      assertionId: `${this.input.context_id}/${String(this.rows.length).padStart(6, "0")}`,
      sourceObjectId: interpretationNodeIdentity(source), targetObjectId: interpretationNodeIdentity(target),
      resultObjectId: interpretationNodeIdentity(target), predicate,
      validity: { kind: "interpretation", packet_id: this.input.interpretation_id, hypothesis_id: this.input.context_id },
      interpretation_source: source, interpretation_target: target, source_revision: this.input.interpretation_id
    };
    if (leaf !== undefined) this.origins.set(row.assertionId, leaf);
    const key = JSON.stringify([row.sourceObjectId, predicate]), bucket = this.adjacency.get(key) ?? [];
    this.positions.set(row.assertionId, bucket.length);
    bucket.push(row); this.adjacency.set(key, bucket); this.rows.push(row);
  }
  self(id: string, parts: readonly (string | number)[], leaf?: SourceSemanticConsumedLeaf): void {
    this.edge(id, id, sourceSemanticRelationKey(...parts), leaf);
  }
}

function populateOccurrences(builder: PremiseBuilder, h: SourceSemanticInterpretation): void {
  const asserted = new Set(h.asserted_at_scope);
  for (const row of [...h.frames, ...h.operators]) {
    builder.self(row.id, ["h_presence"], { leaf_kind: "h_presence", occurrence: row.id });
    const sort = "operator" in row ? "context" : "proposition";
    builder.self(row.id, ["h_sort", sort], { leaf_kind: "h_sort", occurrence: row.id, value: sort });
    if ("operator" in row) builder.self(row.id, ["h_operator", row.operator], { leaf_kind: "h_operator", occurrence: row.id, value: row.operator });
    if (asserted.has(row.id)) builder.self(row.id, ["h_assertion_permission"], { leaf_kind: "h_assertion_permission", occurrence: row.id });
    else builder.self(row.id, ["open_context"], { leaf_kind: "h_context", occurrence: row.id });
    if (row.context_owner.kind === "source_act") builder.self(row.id, ["source_act", row.context_owner.source_act],
      { leaf_kind: "h_source_act", occurrence: row.id, value: row.context_owner.source_act });
    builder.self(row.id, ["candidate_route"]); builder.self(row.id, ["accept"]);
  }
  for (const row of h.referents) if (row.referent_kind === "grouped" || row.referent_kind === "unexpressed") {
    builder.self(row.id, ["h_sort", "entity"], { leaf_kind: "h_sort", occurrence: row.id, value: "entity" });
  }
}

function populateStructure(builder: PremiseBuilder, h: SourceSemanticInterpretation): void {
  const parents = new Map<string, string>();
  for (const edge of sourceSemanticStructuralEdges(h)) {
    const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "h_content", occurrence: edge.to,
      parent: edge.from, relation_kind: edge.kind, role: edge.role };
    builder.edge(edge.from, edge.to, sourceSemanticRelationKey("h_content", edge.kind, edge.role), leaf);
    builder.edge(edge.to, edge.from, sourceSemanticRelationKey("h_content_inv", edge.kind, edge.role), leaf);
    if (edge.governing) { parents.set(edge.to, edge.from); builder.self(edge.to, ["h_embedded"], leaf); }
  }
  for (const row of [...h.frames, ...h.operators]) {
    let ancestor = parents.get(row.id);
    const visited = new Set<string>([row.id]);
    while (ancestor !== undefined) {
      if (visited.has(ancestor)) throw new CoreError("OBLIGATION_VIOLATION", "cyclic source domination");
      visited.add(ancestor);
      builder.edge(ancestor, row.id, sourceSemanticRelationKey("candidate_route")); ancestor = parents.get(ancestor);
    }
  }
}

function populateBindings(builder: PremiseBuilder, h: SourceSemanticInterpretation): void {
  for (const frame of h.frames) for (const binding of frame.bindings) {
    if (binding.target.kind !== "node") continue;
    const slot = builder.slotNodes.get(JSON.stringify([frame.id, binding.slot_id]))!;
    const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "h_binding", occurrence: frame.id, slot_id: binding.slot_id, target: binding.target.id };
    builder.edge(slot, binding.target.id, sourceSemanticRelationKey("h_binding"), leaf);
    builder.edge(binding.target.id, slot, sourceSemanticRelationKey("h_binding_inv"), leaf);
  }
}

function populateAlignment(builder: PremiseBuilder, alignment: SourceSemanticAlignment): void {
  for (const [index, correspondence] of alignment.correspondences.entries()) {
    const query = correspondence.query_endpoint, source = correspondence.source_endpoint;
    if (query.kind === "referent" && source.kind === "referent") {
      builder.self(source.referent, ["a_referent", query.variable], { leaf_kind: "a_referent", occurrence: source.referent, correspondence_index: index });
    } else if (query.kind === "predicate" && source.kind === "frame") {
      builder.self(source.frame, ["a_predicate", query.alternative, query.frame], { leaf_kind: "a_predicate", occurrence: source.frame, correspondence_index: index });
    } else if (query.kind === "slot" && source.kind === "slot") {
      const slot = builder.slotNodes.get(JSON.stringify([source.frame, source.slot]))!;
      const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "a_slot", occurrence: source.frame, slot_id: source.slot, correspondence_index: index };
      builder.edge(source.frame, slot, sourceSemanticRelationKey("a_slot", query.alternative, query.frame, query.slot), leaf);
      builder.edge(slot, source.frame, sourceSemanticRelationKey("a_slot_inv", query.alternative, query.frame, query.slot), leaf);
    }
  }
}

export function sourceSemanticReaders(
  population: SourceSemanticPremisePopulation,
  seeds: readonly string[]
): ObserverReaders {
  return {
    lexical: ({ afterObjectId, limit, nativeLimit }) => {
      const remaining = seeds.filter((id) => id > (afterObjectId ?? "")).sort();
      const ids = remaining.slice(0, Math.min(limit, nativeLimit));
      const bytes = Buffer.byteLength(JSON.stringify(ids));
      return {
        ids, nativeVisits: ids.length, nativeBytes: bytes, rowsRead: ids.length, bytesRead: bytes,
        truncated: remaining.length > ids.length, committedThrough: ids.at(-1) ?? afterObjectId
      };
    },
    source: ({ objectId, byteLimit }) => {
      const row = population.nodes.get(objectId) ?? null;
      const bytes = Buffer.byteLength(JSON.stringify(row));
      if (bytes > (byteLimit ?? Infinity)) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true, resourceLimited: true };
      }
      return { row, rowsRead: 1, bytesRead: bytes, unavailable: row === null };
    },
    sourceRoots: () => ({
      rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0,
      truncated: false, committedThrough: null
    }),
    relation: ({ subject, predicate, limit, nativeLimit, afterAssertionId, byteLimit }) => {
      const bucket = population.adjacency.get(JSON.stringify([subject, predicate])) ?? [];
      const start = afterAssertionId === null ? 0 : (population.positions.get(afterAssertionId) ?? bucket.length) + 1;
      const observations: RelationObserverRow[] = [];
      let bytes = 0;
      let position = start;
      const stop = Math.min(bucket.length, start + Math.min(limit, nativeLimit));
      while (position < stop) {
        const row = bucket[position]!;
        const size = Buffer.byteLength(JSON.stringify(row));
        if (bytes + size > (byteLimit ?? Infinity)) break;
        observations.push(row);
        bytes += size;
        position += 1;
      }
      return {
        observations, nativeVisits: observations.length, nativeBytes: bytes,
        rowsRead: observations.length, bytesRead: bytes, truncated: position < bucket.length,
        committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId
      };
    }
  };
}
