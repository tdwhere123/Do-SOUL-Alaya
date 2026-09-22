import { expect, it } from "vitest";
import {
  canonicalProductIdentityOfEntry, IndexEntrySchema, sourceIndexEntry, type IndexEntry
} from "@do-soul/alaya-protocol";
import {
  assembleSourceSemanticLibraryIndex, sourceGoldRootIdentity
} from "../../../recall/runtime/source-semantic-library-recall.js";
import { preparedDeliveryId } from "../../../recall/runtime/index-continuation.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const CLOCK = "2026-09-18T00:00:00.000Z";
const SNAPSHOT = `sha256:${"cd".repeat(32)}`;

function sourceOnly(root: string): IndexEntry {
  return sourceIndexEntry({
    workspace_id: "ws", root_kind: "source_record", root_id: root, source_version: "1",
    content_digest: DIGEST, evidence_object_id: null, association_milligrades: 0,
    program_state: "accepting", time_state: "as_of"
  });
}

function proofBinding(root: string, binding: string, node: string): IndexEntry {
  const base = sourceOnly(root);
  return IndexEntrySchema.parse({
    ...base,
    output_binding: binding,
    explanation_ids: ["ex-1"],
    interpretation_node: { packet_id: `h-${root}`, hypothesis_id: base.hypothesis_id, node_id: node }
  });
}

it("occupies one first-five slot per source root and keeps a source without a source interpretation", () => {
  const goldProofs = Array.from({ length: 6 }, (_, index) => proofBinding("gold", `bind-${String(index)}`, `n${String(index)}`));
  const failed = sourceOnly("failed");
  const assembled = assembleSourceSemanticLibraryIndex({
    query_id: "library-query", snapshot_id: SNAPSHOT, interpretation_id: "library-interpretation",
    as_of: CLOCK, proof_groups: [{ entries: goldProofs }], source_entries: [failed, sourceOnly("gold")],
    truncated: false, open_residuals: false
  });
  expect(assembled.omitted_duplicate_bindings).toBeGreaterThanOrEqual(5);
  const firstFive = assembled.index.entries.slice(0, 5);
  const roots = firstFive.map((entry) => entry.target.kind === "source_evidence" ? sourceGoldRootIdentity(entry.target) : "");
  expect(new Set(roots).size).toBe(roots.length);
  expect(firstFive.filter((entry) => entry.target.kind === "source_evidence" && entry.target.root_id === "gold")).toHaveLength(1);
  expect(assembled.index.entries.some((entry) => entry.target.kind === "source_evidence"
    && entry.target.root_id === "failed" && entry.interpretation_node === undefined
    && entry.explanation_ids.length === 0)).toBe(true);
  expect(assembled.index.page_purpose).toBe("membership");
  expect(assembled.index.entries.length).toBeLessThanOrEqual(10);
});

it("pages occupied membership after the first page budget", () => {
  const sources = Array.from({ length: 12 }, (_, index) => sourceOnly(`root-${String(index).padStart(2, "0")}`));
  const first = assembleSourceSemanticLibraryIndex({
    query_id: "library-query", snapshot_id: SNAPSHOT, interpretation_id: "library-interpretation",
    as_of: CLOCK, proof_groups: [], source_entries: sources, truncated: false, open_residuals: false
  });
  expect(first.index.entries).toHaveLength(10);
  expect(first.index.continuation).not.toBeNull();
  expect(first.index.continuation?.cursor).toBe("offset-10");
  expect(first.index.completeness.logical_index).toBe("partial");
  const second = assembleSourceSemanticLibraryIndex({
    query_id: "library-query", snapshot_id: SNAPSHOT, interpretation_id: "library-interpretation",
    as_of: CLOCK, proof_groups: [], source_entries: sources, truncated: false, open_residuals: false, offset: 10
  });
  expect(second.index.entries).toHaveLength(2);
  expect(second.index.continuation).toBeNull();
  expect(second.index.completeness.logical_index).toBe("complete");
  const firstIds = new Set(first.index.entries.map(canonicalProductIdentityOfEntry));
  expect(second.index.entries.some((entry) => firstIds.has(canonicalProductIdentityOfEntry(entry)))).toBe(false);
});

it("changes preparedDeliveryId when delivered entries or request digest change", () => {
  const proof = assembleSourceSemanticLibraryIndex({
    query_id: "library-query", snapshot_id: SNAPSHOT, interpretation_id: "library-interpretation",
    as_of: CLOCK, proof_groups: [{ entries: [proofBinding("gold", "bind-1", "n1")] }],
    source_entries: [sourceOnly("gold")], truncated: false, open_residuals: false
  });
  const sourceOnlyIndex = assembleSourceSemanticLibraryIndex({
    query_id: "library-query", snapshot_id: SNAPSHOT, interpretation_id: "library-interpretation",
    as_of: CLOCK, proof_groups: [], source_entries: [sourceOnly("gold")], truncated: false, open_residuals: false
  });
  expect(preparedDeliveryId("same-digest", proof.index))
    .not.toBe(preparedDeliveryId("same-digest", sourceOnlyIndex.index));
  expect(preparedDeliveryId("budget-a", proof.index)).not.toBe(preparedDeliveryId("budget-b", proof.index));
});
