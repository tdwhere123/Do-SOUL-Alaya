import { interpretationNodeIdentity, sourceInterpretationRelationKey,
  type SourceInterpretationReasoningResult, type InterpretationNodeCoordinate, type PublishedSourceInterpretationPacket } from "@do-soul/alaya-protocol";
import type { ObserverReaders, RelationObserverRow, SourceObserverRow } from "../conditional-field/observers/observe.js";

/** Structural incidence is conditional on one packet; no global entity or world relation is minted. */
export class InterpretationPreparationLimit extends Error {
  constructor(readonly work: number) { super("interpretation preparation budget exhausted"); }
}

export function compileSourceInterpretationPremises(bound: PublishedSourceInterpretationPacket, scope: string,
  budget: Readonly<{ work_units: number; memory_bytes: number }>,
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>) {
  let work = 1 + bound.packet.mentions.length;
  let bytes = Buffer.byteLength(JSON.stringify(bound));
  const charge = (value: unknown) => {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (work + 1 >= budget.work_units || bytes + size >= budget.memory_bytes) throw new InterpretationPreparationLimit(work);
    work += 1; bytes += size;
  };
  const { packet } = bound;
  const validity = sourceValidity === undefined ? {} : { valid_from: sourceValidity.valid_from, valid_to: sourceValidity.valid_to };
  const nodes = new Map<string, SourceObserverRow>();
  const coordinates = new Map<string, InterpretationNodeCoordinate>();
  for (const node of [...packet.referents, ...packet.propositions, ...packet.operators]) {
    const coordinate = { packet_id: bound.packet_id, hypothesis_id: bound.hypothesis_id, node_id: node.id };
    const id = interpretationNodeIdentity(coordinate);
    charge([node.id, coordinate, id, { object_id: id, sourceRevision: bound.packet_id, target: bound.source_target,
      interpretation_node: coordinate, lifecycle_state: "active", scope_class: scope, ...validity }]);
    coordinates.set(node.id, coordinate);
    nodes.set(id, { object_id: id, sourceRevision: bound.packet_id, target: bound.source_target,
      interpretation_node: coordinate, lifecycle_state: "active", scope_class: scope, ...validity });
  }
  const rows: RelationObserverRow[] = [];
  const adjacency = new Map<string, RelationObserverRow[]>();
  const positions = new Map<string, number>();
  const origins = new Map<string, SourceInterpretationReasoningResult["premises"][number]>();
  const emit = (statement: (typeof packet.propositions)[number] | (typeof packet.operators)[number], from: string, to: string, kind: Parameters<typeof sourceInterpretationRelationKey>[0], symbol: string) => {
    const source = coordinates.get(from)!;
    const target = coordinates.get(to)!;
    const row: RelationObserverRow = { assertionId: `${bound.packet_id}/${String(rows.length).padStart(5, "0")}`,
      sourceObjectId: interpretationNodeIdentity(source), targetObjectId: interpretationNodeIdentity(target),
      resultObjectId: interpretationNodeIdentity(target), predicate: sourceInterpretationRelationKey(kind, symbol),
      validity: { kind: "interpretation", packet_id: bound.packet_id, hypothesis_id: bound.hypothesis_id },
      interpretation_source: source, interpretation_target: target, source_revision: bound.packet_id };
    const key = JSON.stringify([row.sourceObjectId, row.predicate]);
    const origin = { premise_id: row.assertionId, relation_kind: row.predicate, statement_id: statement.id,
      from_node: from, to_node: to,
      source_assertions: bound.assertions.filter((assertion) => statement.assertion_ids.includes(assertion.assertion_id)) };
    charge([row, key, row.assertionId, rows.length, origin]);
    origins.set(row.assertionId, origin);
    const bucket = adjacency.get(key) ?? [];
    positions.set(row.assertionId, bucket.length);
    bucket.push(row); adjacency.set(key, bucket); rows.push(row);
  };
  for (const proposition of packet.propositions) {
    emit(proposition, proposition.id, proposition.id, "predicate", proposition.predicate);
    if (packet.roots.includes(proposition.id)) emit(proposition, proposition.id, proposition.id, "asserted", proposition.predicate);
    for (const arg of proposition.arguments) {
      emit(proposition, proposition.id, arg.target, "role", arg.role);
      emit(proposition, arg.target, proposition.id, "inverse_role", arg.role);
    }
  }
  for (const operator of packet.operators) {
    emit(operator, operator.id, operator.id, "operator", operator.operator);
    for (const operand of operator.operands) emit(operator, operator.id, operand.target, "role", operand.role);
  }
  return { nodes, rows, coordinates, adjacency, positions, origins, work, bytes };
}

export function sourceInterpretationReaders(population: ReturnType<typeof compileSourceInterpretationPremises>,
  seeds: readonly string[]): ObserverReaders {
  return {
    lexical: ({ afterObjectId, limit, nativeLimit }) => {
      const remaining = seeds.filter((id) => id > (afterObjectId ?? "")).sort();
      const ids = remaining.slice(0, Math.min(limit, nativeLimit));
      const bytes = Buffer.byteLength(JSON.stringify(ids));
      return { ids, nativeVisits: ids.length, nativeBytes: bytes, rowsRead: ids.length, bytesRead: bytes,
        truncated: remaining.length > ids.length, committedThrough: ids.at(-1) ?? afterObjectId };
    },
    source: ({ objectId, byteLimit }) => {
      const row = population.nodes.get(objectId) ?? null;
      const bytes = Buffer.byteLength(JSON.stringify(row));
      if (bytes > (byteLimit ?? Infinity)) return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true, resourceLimited: true };
      return { row, rowsRead: 1, bytesRead: bytes, unavailable: row === null };
    },
    sourceRoots: () => ({ rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0,
      truncated: false, committedThrough: null }),
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
        observations.push(row); bytes += size; position += 1;
      }
      return { observations, nativeVisits: observations.length, nativeBytes: bytes,
        rowsRead: observations.length, bytesRead: bytes, truncated: position < bucket.length,
        committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
    }
  };
}
