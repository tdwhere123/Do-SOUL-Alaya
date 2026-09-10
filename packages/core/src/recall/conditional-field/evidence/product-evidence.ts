import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { productSubjectId, type FieldValue } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../engine/field-engine.js";
import { traceDerivationForest, type DerivationTraversal } from "../engine/derivation-provenance.js";
import { transitionKey } from "../engine/path-composition.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import type { RelationObserverRow } from "../observers/observe.js";

export type ProductEvidenceCursor = Readonly<{
  phase: "transitions" | "provenance" | "leaves" | "rows" | "complete";
  transition_offset: number;
  roots: PersistentStringMap<string>;
  provenance?: DerivationTraversal;
  leaf_offset: number;
  leaf_id_offset: number;
  assertion_ids: PersistentStringMap<true>;
  relation_offset: number;
  receipt_offset: number;
}>;

export function prepareProductEvidence(input: Readonly<{
  state: FieldEngineState; value: FieldValue; claimKind?: string; causeSource?: string;
  progress?: ProductEvidenceCursor; workLimit: number; memoryLimit: number;
}>): Readonly<{ progress: ProductEvidenceCursor; rows: readonly RelationObserverRow[]; work: number; retained_bytes: number; complete: boolean }> {
  let cursor: ProductEvidenceCursor = input.progress ?? { phase: input.value.state.target.kind === "memory_entry" ? "transitions" : "complete",
    transition_offset: 0, roots: new PersistentStringMap(), leaf_offset: 0, leaf_id_offset: 0,
    assertion_ids: new PersistentStringMap(), relation_offset: 0, receipt_offset: 0 };
  const key = productStateNodeId(input.value.state);
  const rows: RelationObserverRow[] = [];
  let work = 0;
  let retained = 0;
  let assessmentReserve = 2;
  const withdrawn = new Set(input.state.withdrawn_leaves ?? []);
  while (work < input.workLimit) {
    if (cursor.phase === "complete") break;
    if (cursor.phase === "transitions") {
      const edge = input.state.transitions.at(cursor.transition_offset);
      if (edge === undefined) { cursor = { ...cursor, phase: "provenance" }; continue; }
      const root = edge.applicable && productStateNodeId(edge.to) === key ? input.state.transition_derivations.get(transitionKey(edge)) : undefined;
      const bytes = root === undefined ? 0 : 96 + Buffer.byteLength(root, "utf8");
      if (retained + bytes > input.memoryLimit) break;
      cursor = { ...cursor, transition_offset: cursor.transition_offset + 1,
        roots: root === undefined ? cursor.roots : cursor.roots.with(String(cursor.roots.size).padStart(16, "0"), root) };
      retained += bytes; work += 1;
      continue;
    }
    if (cursor.phase === "provenance") {
      const capacity = Math.min(input.workLimit - work, Math.floor((input.memoryLimit - retained) / 320));
      if (capacity < 1) break;
      const roots = cursor.roots;
      const traced = traceDerivationForest({ roots: { length: roots.size, at: (index) => roots.entryAt(index)?.[1] },
        forest: input.state.retained_index?.derivations ?? { get: (id) => input.state.derivations.find((row) => row.derivation_id === id) },
        progress: cursor.provenance, maxVisits: capacity });
      work += traced.work; retained += traced.work * 320;
      cursor = { ...cursor, provenance: traced.traversal,
        phase: traced.complete ? "leaves" : traced.traversal.invalid ? "rows" : "provenance" };
      continue;
    }
    if (cursor.phase === "leaves") {
      const leaf = cursor.provenance?.leaves.entryAt(cursor.leaf_offset)?.[1];
      if (leaf === undefined) { cursor = { ...cursor, phase: "rows" }; continue; }
      const id = leaf.leaf_ids[cursor.leaf_id_offset];
      if (id === undefined) { cursor = { ...cursor, leaf_offset: cursor.leaf_offset + 1, leaf_id_offset: 0 }; continue; }
      const bytes = 96 + Buffer.byteLength(id, "utf8");
      if (retained + bytes > input.memoryLimit) break;
      cursor = { ...cursor, leaf_id_offset: cursor.leaf_id_offset + 1, assertion_ids: cursor.assertion_ids.with(id, true) };
      retained += bytes; work += 1;
      continue;
    }
    const row = input.state.observed_relations?.at(cursor.relation_offset);
    if (row === undefined) { cursor = { ...cursor, phase: "complete" }; continue; }
    const matches = row.targetObjectId === productSubjectId(input.value.state) && !withdrawn.has(row.assertionId)
      && (cursor.assertion_ids.has(row.assertionId) || row.predicate === input.claimKind && row.sourceObjectId === input.causeSource);
    const receipt = matches ? row.evidenceReceipts?.[cursor.receipt_offset] : undefined;
    if (receipt === undefined) {
      cursor = { ...cursor, relation_offset: cursor.relation_offset + 1, receipt_offset: 0 };
      work += 1;
      continue;
    }
    if (work + assessmentReserve + 9 > input.workLimit) break;
    cursor = { ...cursor, receipt_offset: cursor.receipt_offset + 1 };
    work += 1;
    if (withdrawn.has(receipt.evidenceId) || withdrawn.has(receipt.eventId)) continue;
    assessmentReserve += 8;
    rows.push({ ...row, evidenceReceipts: [receipt] });
    break;
  }
  return { progress: cursor, rows, work, retained_bytes: retained, complete: cursor.phase === "complete" };
}
