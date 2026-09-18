import {
  interpretationNodeIdentity,
  type InterpretationNodeCoordinate,
  type SourceEvidenceTarget,
  type SourceSemanticAlignment,
  type SourceSemanticConsumedLeaf,
  type SourceSemanticContextOwner,
  type SourceSemanticInterpretation,
  type SourceSemanticOperator
} from "@do-soul/alaya-protocol";
import type { ObserverReaders, RelationObserverRow, SourceObserverRow } from "../conditional-field/observers/observe.js";

/** Traversal activation is not assertion; empty-premise rules must not vacuous-fire. */
export class SourceSemanticPreparationLimit extends Error {
  constructor(readonly work: number) { super("source semantic preparation budget exhausted"); }
}

export function sourceSemanticRelationKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(["source-interpretation-v3", ...parts]);
}

export type SourceSemanticPremisePopulation = Readonly<{
  readonly nodes: ReadonlyMap<string, SourceObserverRow>;
  readonly rows: readonly RelationObserverRow[];
  readonly coordinates: ReadonlyMap<string, InterpretationNodeCoordinate>;
  readonly adjacency: ReadonlyMap<string, RelationObserverRow[]>;
  readonly positions: ReadonlyMap<string, number>;
  readonly origins: ReadonlyMap<string, SourceSemanticConsumedLeaf>;
  readonly work: number;
  readonly bytes: number;
}>;

export function compileSourceSemanticPremises(input: Readonly<{
  interpretation: SourceSemanticInterpretation;
  alignment: SourceSemanticAlignment;
  context_id: string;
  interpretation_id: string;
  scope: string;
  source_target: SourceEvidenceTarget;
  budget: Readonly<{ work_units: number; memory_bytes: number }>;
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
}>): SourceSemanticPremisePopulation {
  let work = 1 + input.interpretation.mentions.length;
  let bytes = Buffer.byteLength(JSON.stringify(input.interpretation));
  const charge = (value: unknown) => {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (work + 1 >= input.budget.work_units || bytes + size >= input.budget.memory_bytes) {
      throw new SourceSemanticPreparationLimit(work);
    }
    work += 1;
    bytes += size;
  };
  const validity = input.sourceValidity === undefined
    ? {}
    : { valid_from: input.sourceValidity.valid_from, valid_to: input.sourceValidity.valid_to };
  const nodes = new Map<string, SourceObserverRow>();
  const coordinates = new Map<string, InterpretationNodeCoordinate>();
  const occurrences = [...input.interpretation.frames, ...input.interpretation.operators];
  const referents = input.interpretation.referents;
  for (const node of [...referents, ...occurrences]) {
    const coordinate = {
      packet_id: input.interpretation_id,
      hypothesis_id: input.context_id,
      node_id: node.id
    };
    const id = interpretationNodeIdentity(coordinate);
    charge([node.id, coordinate, id]);
    coordinates.set(node.id, coordinate);
    nodes.set(id, {
      object_id: id,
      sourceRevision: input.interpretation_id,
      target: input.source_target,
      interpretation_node: coordinate,
      lifecycle_state: "active",
      scope_class: input.scope,
      ...validity
    });
  }
  const rows: RelationObserverRow[] = [];
  const adjacency = new Map<string, RelationObserverRow[]>();
  const positions = new Map<string, number>();
  const origins = new Map<string, SourceSemanticConsumedLeaf>();
  const emit = (from: string, to: string, predicate: string, leaf?: SourceSemanticConsumedLeaf) => {
    const source = coordinates.get(from)!;
    const target = coordinates.get(to)!;
    const row: RelationObserverRow = {
      assertionId: `${input.context_id}/${String(rows.length).padStart(5, "0")}`,
      sourceObjectId: interpretationNodeIdentity(source),
      targetObjectId: interpretationNodeIdentity(target),
      resultObjectId: interpretationNodeIdentity(target),
      predicate,
      validity: { kind: "interpretation", packet_id: input.interpretation_id, hypothesis_id: input.context_id },
      interpretation_source: source,
      interpretation_target: target,
      source_revision: input.interpretation_id
    };
    const key = JSON.stringify([row.sourceObjectId, row.predicate]);
    charge([row, key, leaf]);
    if (leaf !== undefined) origins.set(row.assertionId, leaf);
    const bucket = adjacency.get(key) ?? [];
    positions.set(row.assertionId, bucket.length);
    bucket.push(row);
    adjacency.set(key, bucket);
    rows.push(row);
  };
  const presence = (id: string) => emit(id, id, sourceSemanticRelationKey("h_presence"), {
    leaf_kind: "h_presence", occurrence: id
  });
  const asserted = new Set(input.interpretation.asserted_at_scope);
  for (const row of occurrences) {
    presence(row.id);
    if (asserted.has(row.id)) {
      emit(row.id, row.id, sourceSemanticRelationKey("h_assertion_permission"), {
        leaf_kind: "h_assertion_permission", occurrence: row.id
      });
    } else {
      emit(row.id, row.id, sourceSemanticRelationKey("open_context"));
    }
    const owner = row.context_owner;
    if (owner.kind === "source_act") {
      emit(row.id, row.id, sourceSemanticRelationKey("source_act", owner.source_act));
    }
    if (owner.kind === "embedding" || owner.kind === "operator") {
      emit(row.id, row.id, sourceSemanticRelationKey("h_embedded"), {
        leaf_kind: "h_content", occurrence: row.id
      });
    }
    emit(row.id, row.id, sourceSemanticRelationKey("candidate_route"));
  }
  for (const row of occurrences) {
    if (row.context_owner.kind !== "embedding") continue;
    emitContent(emit, row.context_owner.parent_frame, row.id, "content");
  }
  for (const operator of input.interpretation.operators) emitOperatorContent(emit, operator);
  const children = dominationChildren(input.interpretation);
  for (const row of occurrences) {
    for (const descendant of descendants(children, row.id)) {
      emit(row.id, descendant, sourceSemanticRelationKey("candidate_route"));
    }
  }
  const frames = new Map(input.interpretation.frames.map((row) => [row.id, row]));
  for (const [index, correspondence] of input.alignment.correspondences.entries()) {
    const query = correspondence.query_endpoint;
    const source = correspondence.source_endpoint;
    if (query.kind === "predicate") {
      if (source.kind !== "frame") continue;
      emit(source.frame, source.frame, sourceSemanticRelationKey("a_predicate", query.alternative, query.frame), {
        leaf_kind: "a_predicate", occurrence: source.frame, correspondence_index: index
      });
      continue;
    }
    if (source.kind !== "slot") continue;
    const frame = frames.get(source.frame);
    emit(source.frame, source.frame, sourceSemanticRelationKey("a_slot", query.alternative, query.frame, query.slot), {
      leaf_kind: "a_slot", occurrence: source.frame, slot_id: source.slot, correspondence_index: index
    });
    const binding = frame?.bindings.find((row) => row.slot_id === source.slot);
    if (binding === undefined || binding.target.kind !== "node") continue;
    const leaf: SourceSemanticConsumedLeaf = {
      leaf_kind: "h_binding", occurrence: source.frame, slot_id: source.slot
    };
    emit(source.frame, binding.target.id, sourceSemanticRelationKey("h_binding", query.alternative, query.frame, query.slot), leaf);
    emit(binding.target.id, source.frame, sourceSemanticRelationKey("h_binding_inv", query.alternative, query.frame, query.slot), leaf);
  }
  return { nodes, rows, coordinates, adjacency, positions, origins, work, bytes };
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

function emitContent(
  emit: (from: string, to: string, predicate: string, leaf?: SourceSemanticConsumedLeaf) => void,
  from: string,
  to: string,
  role: string
): void {
  const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "h_content", occurrence: to };
  emit(from, to, sourceSemanticRelationKey("h_content", role), leaf);
  emit(to, from, sourceSemanticRelationKey("h_content_inv", role), leaf);
}

function emitOperatorContent(
  emit: (from: string, to: string, predicate: string, leaf?: SourceSemanticConsumedLeaf) => void,
  operator: SourceSemanticOperator
): void {
  if (operator.operator === "conditional") {
    emitContent(emit, operator.id, operator.antecedent, "antecedent");
    emitContent(emit, operator.id, operator.consequent, "consequent");
    return;
  }
  if (operator.operator === "opaque") {
    for (const operand of operator.operands) emitContent(emit, operator.id, operand, "content");
    return;
  }
  emitContent(emit, operator.id, operator.content, "content");
}

function dominationChildren(interpretation: SourceSemanticInterpretation): Map<string, string[]> {
  const children = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = children.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    children.set(from, list);
  };
  for (const operator of interpretation.operators) {
    if (operator.operator === "conditional") {
      add(operator.id, operator.antecedent);
      add(operator.id, operator.consequent);
    } else if (operator.operator === "opaque") {
      for (const id of operator.operands) add(operator.id, id);
    } else add(operator.id, operator.content);
  }
  for (const row of [...interpretation.frames, ...interpretation.operators]) {
    const owner: SourceSemanticContextOwner = row.context_owner;
    if (owner.kind === "embedding") add(owner.parent_frame, row.id);
    else if (owner.kind === "operator") add(owner.operator_handle, row.id);
  }
  return children;
}

function descendants(children: Map<string, string[]>, start: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(children.get(start) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}
