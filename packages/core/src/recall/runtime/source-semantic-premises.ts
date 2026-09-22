import {
  interpretationNodeIdentity, sourceSemanticStructuralEdges, sourceSemanticSlotNodeId, SourceSemanticResourceLedger,
  type InterpretationNodeCoordinate, type SourceEvidenceTarget, type SourceSemanticCorrespondence,
  type SourceSemanticConsumedLeaf, type SourceSemanticInterpretation, type SourceSemanticQuery,
  type SourceSemanticDerivedNode
} from "@do-soul/alaya-protocol";
import { groundSourceSemanticInstances, type SourceSemanticInstance } from "./source-semantic-instances.js";
import { populateSourceSemanticFiniteFacts } from "./source-semantic-finite-facts.js";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import type { ObserverReaders, RelationObserverRow, SourceObserverRow } from "../conditional-field/observers/observe.js";

export function sourceSemanticRelationKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(["source-semantic-relations-v5", ...parts]);
}
/** Predicate-aligned source frames for one query alternative, in stable order. */
export function correspondencePredicateGroups(
  semantic_correspondence: SourceSemanticCorrespondence | undefined, alternative: number, queryFrame?: string
): readonly string[] {
  if (semantic_correspondence === undefined) return [];
  const frames = new Set<string>();
  for (const row of semantic_correspondence.correspondences) {
    const query = row.query_endpoint, source = row.source_endpoint;
    if (query.kind === "predicate" && source.kind === "frame" && query.alternative === alternative
      && (queryFrame === undefined || query.frame === queryFrame)) {
      frames.add(source.frame);
    }
  }
  return [...frames].sort();
}
/** Split only when one query predicate is instantiated on several source frames. */
export function correspondenceGroupPhases(
  query: SourceSemanticQuery | undefined, semantic_correspondence: SourceSemanticCorrespondence | undefined, alternative: number
): readonly (string | undefined)[] {
  const branch = query?.alternatives[alternative];
  const predicateFrames = branch?.frames.filter((frame) => frame.operator === undefined) ?? [];
  if (predicateFrames.length !== 1) return [undefined];
  const frames = correspondencePredicateGroups(semantic_correspondence, alternative, predicateFrames[0]!.id);
  return frames.length === 0 ? [undefined] : frames;
}
/** Slots stay on the chosen predicate frame; a shared query key searches every aligned frame. */
export function correspondencePredicateKey(alternative: number, queryFrame: string, groupFrame?: string): string {
  return groupFrame === undefined
    ? sourceSemanticRelationKey("semantic_correspondence_predicate", alternative, queryFrame)
    : sourceSemanticRelationKey("semantic_correspondence_predicate", alternative, queryFrame, groupFrame);
}
export function correspondenceSlotKey(
  direction: "semantic_correspondence_slot" | "semantic_correspondence_slot_inverse", alternative: number, queryFrame: string, slot: string, groupFrame?: string
): string {
  return groupFrame === undefined
    ? sourceSemanticRelationKey(direction, alternative, queryFrame, slot)
    : sourceSemanticRelationKey(direction, alternative, queryFrame, slot, groupFrame);
}
/** Coordinates remain bounded independently of source-handle lengths; conditional computation binds their meaning. */
export function sourceSemanticDerivedNodeId(kind: string, ...parts: readonly string[]): string {
  return `@${kind}:${fieldContractSha256(JSON.stringify(parts)).slice(0, 48)}`;
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
  instances: ReadonlyMap<string, SourceSemanticInstance>;
  derivedNodes: readonly SourceSemanticDerivedNode[];
}>;
type Input = Readonly<{
  interpretation: SourceSemanticInterpretation; semantic_correspondence: SourceSemanticCorrespondence;
  context_id: string; interpretation_id: string; scope: string; source_target: SourceEvidenceTarget;
  meter: SourceSemanticResourceLedger;
  query?: SourceSemanticQuery;
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
}>;

/** Source interpretation forms bindings independently; semantic correspondence supplies endpoint-bound adapters, not answer seeds. */
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
  groundSourceSemanticInstances(builder, h, input.semantic_correspondence, input.query);
  populateSourceSemanticFiniteFacts(builder, h, input.semantic_correspondence);
  populateCorrespondence(builder, input.semantic_correspondence);
  return { nodes: builder.nodes, rows: builder.rows, coordinates: builder.coordinates,
    adjacency: builder.adjacency, positions: builder.positions, origins: builder.origins,
    work: meter.spentWork - workBefore, bytes: meter.spentBytes - bytesBefore,
    instances: builder.instances, derivedNodes: builder.derivedNodes };
}

export class PremiseBuilder {
  readonly nodes = new Map<string, SourceObserverRow>();
  readonly coordinates = new Map<string, InterpretationNodeCoordinate>();
  readonly rows: RelationObserverRow[] = [];
  readonly adjacency = new Map<string, RelationObserverRow[]>();
  readonly positions = new Map<string, number>();
  readonly origins = new Map<string, SourceSemanticConsumedLeaf>();
  readonly slotNodes = new Map<string, string>();
  readonly instances = new Map<string, SourceSemanticInstance>();
  readonly derivedNodes: SourceSemanticDerivedNode[] = [];
  readonly aliases = new Map<string, string>();
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
    if (leaf !== undefined) this.origins.set(row.assertionId, this.provenance(leaf));
    const key = JSON.stringify([row.sourceObjectId, predicate]), bucket = this.adjacency.get(key) ?? [];
    this.positions.set(row.assertionId, bucket.length);
    bucket.push(row); this.adjacency.set(key, bucket); this.rows.push(row);
  }
  self(id: string, parts: readonly (string | number)[], leaf?: SourceSemanticConsumedLeaf): void {
    this.edge(id, id, sourceSemanticRelationKey(...parts), leaf);
  }
  private provenance(leaf: SourceSemanticConsumedLeaf): SourceSemanticConsumedLeaf {
    const result = { ...leaf };
    for (const [field, derived] of [["occurrence", "derived_node"], ["parent", "derived_parent"], ["target", "derived_target"]] as const) {
      const value = result[field];
      if (value === undefined || !value.startsWith("@")) continue;
      result[derived] = value;
      const template = this.aliases.get(value);
      if (template === undefined) delete result[field]; else result[field] = template;
    }
    return result;
  }
}

export function populateOccurrences(builder: PremiseBuilder, h: SourceSemanticInterpretation): void {
  const asserted = new Set(h.asserted_at_scope);
  for (const row of [...h.frames, ...h.operators]) {
    builder.self(row.id, ["source_interpretation_presence"], { leaf_kind: "source_interpretation_presence", occurrence: row.id });
    if (!builder.instances.has(row.id)) builder.self(row.id, ["source_interpretation_original"]);
    const sort = "operator" in row ? "context" : "proposition";
    builder.self(row.id, ["source_interpretation_sort", sort], { leaf_kind: "source_interpretation_sort", occurrence: row.id, value: sort });
    if ("operator" in row) builder.self(row.id, ["source_interpretation_operator", row.operator], { leaf_kind: "source_interpretation_operator", occurrence: row.id, value: row.operator });
    if (asserted.has(row.id)) builder.self(row.id, ["source_interpretation_assertion_permission"], { leaf_kind: "source_interpretation_assertion_permission", occurrence: row.id });
    else builder.self(row.id, ["open_context"], { leaf_kind: "source_interpretation_context", occurrence: row.id });
    if (row.context_owner.kind === "source_act") builder.self(row.id, ["source_act", row.context_owner.source_act],
      { leaf_kind: "source_interpretation_source_act", occurrence: row.id, value: row.context_owner.source_act });
    builder.self(row.id, ["candidate_route"]); builder.self(row.id, ["accept"]);
  }
  for (const row of h.referents) if (row.referent_kind === "grouped" || row.referent_kind === "unexpressed") {
    builder.self(row.id, ["source_interpretation_sort", "entity"], { leaf_kind: "source_interpretation_sort", occurrence: row.id, value: "entity" });
  }
}

export function populateStructure(builder: PremiseBuilder, h: SourceSemanticInterpretation): void {
  const parents = new Map<string, string>();
  for (const edge of sourceSemanticStructuralEdges(h)) {
    const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "source_interpretation_content", occurrence: edge.to,
      parent: edge.from, relation_kind: edge.kind, role: edge.role };
    builder.edge(edge.from, edge.to, sourceSemanticRelationKey("source_interpretation_content", edge.kind, edge.role), leaf);
    builder.edge(edge.to, edge.from, sourceSemanticRelationKey("source_interpretation_content_inverse", edge.kind, edge.role), leaf);
    if (edge.governing) { parents.set(edge.to, edge.from); builder.self(edge.to, ["source_interpretation_embedded"], leaf); }
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

export function populateBindings(builder: PremiseBuilder, h: SourceSemanticInterpretation): void {
  for (const frame of h.frames) for (const binding of frame.bindings) {
    if (binding.target.kind !== "node") continue;
    const slot = builder.slotNodes.get(JSON.stringify([frame.id, binding.slot_id]))!;
    const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "source_interpretation_binding", occurrence: frame.id, slot_id: binding.slot_id, target: binding.target.id };
    builder.edge(slot, binding.target.id, sourceSemanticRelationKey("source_interpretation_binding"), leaf);
    builder.edge(binding.target.id, slot, sourceSemanticRelationKey("source_interpretation_binding_inv"), leaf);
  }
}

function populateCorrespondence(builder: PremiseBuilder, semantic_correspondence: SourceSemanticCorrespondence): void {
  const grouped = new Map<number, readonly (string | undefined)[]>();
  const groupFrame = (alternative: number, frame: string): string | undefined => {
    const frames = grouped.get(alternative) ?? correspondenceGroupPhases(builder.input.query, semantic_correspondence, alternative);
    if (!grouped.has(alternative)) grouped.set(alternative, frames);
    return frames.includes(frame) ? frame : undefined;
  };
  for (const [index, correspondence] of semantic_correspondence.correspondences.entries()) {
    const query = correspondence.query_endpoint, source = correspondence.source_endpoint;
    if (query.kind === "referent" && source.kind === "referent") {
      builder.self(source.referent, ["semantic_correspondence_referent", query.variable], { leaf_kind: "semantic_correspondence_referent", occurrence: source.referent, correspondence_index: index });
    } else if (query.kind === "predicate" && source.kind === "frame") {
      const group = groupFrame(query.alternative, source.frame);
      builder.self(source.frame, group === undefined
        ? ["semantic_correspondence_predicate", query.alternative, query.frame]
        : ["semantic_correspondence_predicate", query.alternative, query.frame, group],
        { leaf_kind: "semantic_correspondence_predicate", occurrence: source.frame, correspondence_index: index });
      for (const [id, template] of builder.aliases) if (template === source.frame) builder.self(id,
        group === undefined ? ["semantic_correspondence_predicate", query.alternative, query.frame] : ["semantic_correspondence_predicate", query.alternative, query.frame, group],
        { leaf_kind: "semantic_correspondence_predicate", occurrence: id, correspondence_index: index });
    } else if (query.kind === "slot" && source.kind === "slot") {
      const slot = builder.slotNodes.get(JSON.stringify([source.frame, source.slot]))!;
      const group = groupFrame(query.alternative, source.frame);
      const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "semantic_correspondence_slot", occurrence: source.frame, slot_id: source.slot, correspondence_index: index };
      builder.edge(source.frame, slot, correspondenceSlotKey("semantic_correspondence_slot", query.alternative, query.frame, query.slot, group), leaf);
      builder.edge(slot, source.frame, correspondenceSlotKey("semantic_correspondence_slot_inverse", query.alternative, query.frame, query.slot, group), leaf);
      for (const [id, template] of builder.aliases) if (template === source.frame) {
        const derivedSlot = builder.slotNodes.get(JSON.stringify([id, source.slot]))!;
        const derivedLeaf = { ...leaf, occurrence: id, derived_target: derivedSlot };
        builder.edge(id, derivedSlot, correspondenceSlotKey("semantic_correspondence_slot", query.alternative, query.frame, query.slot, group), derivedLeaf);
        builder.edge(derivedSlot, id, correspondenceSlotKey("semantic_correspondence_slot_inverse", query.alternative, query.frame, query.slot, group), derivedLeaf);
      }
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
