import {
  canonicalJson, CONDITIONAL_FIELD_SCHEMA_VERSION, InformationIndexSchema,
  SOURCE_SEMANTIC_LIBRARY_OCCUPANCY, SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_LIBRARY_TIE_POLICY, sourceIndexEntry,
  type Continuation, type Derivation, type IndexEntry, type InformationIndex,
  type SourceSemanticLibraryOrder, type SourceSemanticLibrarySlotQualifier,
  type SourceSemanticReasoningResult, type SourceSemanticLibraryProof, type SourceSemanticQuery,
  type SourceSemanticCorrespondence, type SourceSemanticAccessPolicy, type SourceSemanticQueryStatus, type RequestBudget,
  sourceGoldRootIdentity, proofForLibraryEntry, sourceSemanticProofQualifier
} from "@do-soul/alaya-protocol";
import { libraryPageOrder } from "../conditional-field/index/completion-target.js";
import { sortIndexEntries } from "./index-continuation.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
// Payload and delivery-identity tests retain these direct imports; retire this
// adapter when those consumers migrate. Package-root compatibility is independent.
export { encodeSourceSemanticLibraryResults, encodeSourceSemanticLibraryResponse } from "./source-semantic-library-codec.js";

export { sourceGoldRootIdentity, proofForLibraryEntry, proofForLibraryQualifier } from "@do-soul/alaya-protocol";

/** Offline evidence binds its recorded result contract; live requests use the current version. */
export function sourceSemanticLibraryQueryIdentity(originalQuery: string, resultVersion: string = SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION): string {
  return `sha256:${fieldContractSha256(canonicalJson({ kind: resultVersion, query: originalQuery }))}`;
}

/** Resolved execution inputs and admitted or unavailable query status bind every page independently of process-local handles. */
export function sourceSemanticLibraryRequestIdentity(input: Readonly<{
  workspace_id: string; as_of: string; authorized_scopes: readonly string[] | null;
  original_query: string; query_semantics?: SourceSemanticQuery; query_semantics_status: SourceSemanticQueryStatus;
  source_id?: string; access_hint?: string;
  semantic_correspondences: readonly SourceSemanticCorrespondence[];
  budget: RequestBudget; output_byte_limit: number; access_policy: SourceSemanticAccessPolicy;
}>): string {
  const { access_hint, ...request } = input;
  return `sha256:${fieldContractSha256(canonicalJson({ ...request,
    ...(access_hint === undefined ? {} : { access_hint }), query_semantics: input.query_semantics ?? null,
    source_id: input.source_id ?? null,
    authorized_scopes: input.authorized_scopes === null ? null : [...input.authorized_scopes].sort()
  }))}`;
}

export const SOURCE_SEMANTIC_LIBRARY_ORDER: SourceSemanticLibraryOrder = {
  enumeration_policy: "evidence_support",
  tie_policy: SOURCE_SEMANTIC_LIBRARY_TIE_POLICY,
  occupancy: SOURCE_SEMANTIC_LIBRARY_OCCUPANCY,
  occupancy_prefix: SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX,
  page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET
};
export function sourceSemanticLibrarySourceEntry(input: Readonly<{
  workspaceId: string; root_id: string; source_version: string; content_digest: string;
  evidence_object_id: string | null; hypothesis_id: string;
}>): IndexEntry {
  return sourceIndexEntry({
    workspace_id: input.workspaceId, root_kind: "source_record", root_id: input.root_id,
    source_version: input.source_version, content_digest: input.content_digest,
    evidence_object_id: input.evidence_object_id, hypothesis_id: input.hypothesis_id,
    output_binding: "source-evidence", role: "requested", association_milligrades: 0, claim: "unknown",
    explanation_ids: [], program_state: "accepting", time_state: "as_of"
  });
}

export function proofEntriesFromBranch(
  index: InformationIndex, result: SourceSemanticReasoningResult
): { entries: IndexEntry[]; explanations: Derivation[] } {
  const proved = new Set((result.binding_results ?? []).map((row) => row.binding_id));
  const entries = index.entries.filter((entry) => proved.has(entry.output_binding));
  return { entries, explanations: reachableExplanations(index.explanations ?? [], entries) };
}

/** Namespace every branch's proof graph before merging; answer roots and index roots move together. */
export function scopeSourceSemanticLibraryBranch(index: InformationIndex, result: SourceSemanticReasoningResult) {
  const id = (value: string) => `sha256:${fieldContractSha256(canonicalJson({ context: result.conditional_computation_id, derivation: value }))}`;
  const rows = (values: readonly Derivation[] | undefined) => values?.map((row) => ({
    ...row, derivation_id: id(row.derivation_id), children: row.children.map(id)
  }));
  return {
    index: { ...index, entries: index.entries.map((entry) => ({ ...entry, explanation_ids: entry.explanation_ids.map(id) })),
      ...(index.explanations === undefined ? {} : { explanations: rows(index.explanations) }) },
    result: { ...result, binding_results: result.binding_results?.map((row) => ({ ...row, explanation_ids: row.explanation_ids.map(id) })),
      derivations: rows(result.derivations), ...(result.evaluation === undefined ? {} : {
        evaluation: { ...result.evaluation, counterexample_explanation_ids: result.evaluation.counterexample_explanation_ids.map(id) }
      }) }
  };
}

export function assembleSourceSemanticLibraryIndex(input: Readonly<{
  query_id: string; snapshot_id: string; interpretation_id: string; as_of: string;
  proof_groups: readonly { entries: readonly IndexEntry[]; explanations?: readonly Derivation[] }[];
  source_entries: readonly IndexEntry[];
  truncated: boolean; open_residuals: boolean;
  offset?: number; expires_at?: string; authorized_scopes?: readonly string[] | null;
  /** Native selector's frozen root order. Canonical order is only an offline control. */
  root_order?: readonly string[];
  selected_entries?: readonly IndexEntry[];
  more_roots?: boolean; emitted_offset?: number;
}>): { index: InformationIndex; omitted_duplicate_bindings: number; occupied: readonly IndexEntry[] } {
  const merged = mergeProofGroups(input.proof_groups);
  const byRoot = new Map<string, IndexEntry[]>();
  const add = (entry: IndexEntry): void => {
    if (entry.target.kind !== "source_evidence") return;
    const key = sourceGoldRootIdentity(entry.target);
    const rows = byRoot.get(key) ?? [];
    rows.push(entry);
    byRoot.set(key, rows);
  };
  for (const entry of merged.entries) add(entry);
  for (const entry of input.source_entries) add(entry);
  const preferred: IndexEntry[] = [];
  let omitted = 0;
  for (const rows of byRoot.values()) {
    const ranked = sortIndexEntries(rows, "canonical");
    const proof = ranked.find((row) => row.interpretation_node !== undefined && row.explanation_ids.length > 0);
    const selected = input.selected_entries?.find(entry => entry.target.kind === "source_evidence"
      && rows[0]!.target.kind === "source_evidence" && sourceGoldRootIdentity(entry.target) === sourceGoldRootIdentity(rows[0]!.target));
    preferred.push(selected ?? proof ?? ranked[0]!);
    omitted += ranked.length - 1;
  }
  const positions = new Map(input.root_order?.map((root, position) => [root, position]));
  const occupied = sortIndexEntries(preferred, "canonical").sort((left, right) => {
    if (input.root_order === undefined || left.target.kind !== "source_evidence" || right.target.kind !== "source_evidence") return 0;
    return (positions.get(sourceGoldRootIdentity(left.target)) ?? Infinity) - (positions.get(sourceGoldRootIdentity(right.target)) ?? Infinity);
  });
  const offset = Math.max(0, input.offset ?? 0);
  const page = occupied.slice(offset, offset + SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
  const localRemainder = occupied.length > offset + page.length;
  const occupancyRemaining = input.more_roots === true || localRemainder;
  const remaining = occupancyRemaining || input.open_residuals || input.truncated;
  const pageRoots = new Set(page.flatMap(entry => entry.target.kind === "source_evidence" ? [sourceGoldRootIdentity(entry.target)] : []));
  const witnesses = merged.entries.filter(entry => entry.target.kind === "source_evidence" && pageRoots.has(sourceGoldRootIdentity(entry.target)));
  const explanations = reachableExplanations(merged.explanations, witnesses);
  const nextOffset = (input.emitted_offset ?? offset) + page.length;
  const order = libraryPageOrder({
    open_residuals: input.open_residuals, truncated: input.truncated,
    more_roots: input.more_roots === true, page_remainder: localRemainder
  });
  return {
    omitted_duplicate_bindings: omitted,
    occupied,
    index: InformationIndexSchema.parse({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, query_id: input.query_id, snapshot_id: input.snapshot_id,
      result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, entries: page,
      interpretation_id: input.interpretation_id, as_of: input.as_of,
      ...(explanations.length === 0 ? {} : { explanations }),
      completeness: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        logical_index: remaining ? "partial" : "complete",
        observed_coverage: remaining ? "open" : "complete",
        interpretation_coverage: "open", transport: "complete", payload: "complete",
        representation: "complete", claim_coverage: "not_applicable",
        explanation_coverage: explanations.length === 0 ? "not_applicable" : remaining ? "partial" : "complete",
        order_coverage: order.order_coverage,
        pending_computation: remaining ? "open" : "complete"
      },
      continuation: occupancyRemaining ? libraryOccupancyContinuation(input, nextOffset) : null,
      representation: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        policy: "construct_index_then_page_then_payload",
        page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
        identity_tie_break: "serialization"
      },
      order_status: order.order_status,
      page_purpose: "membership"
    })
  };
}

function libraryOccupancyContinuation(input: Readonly<{
  query_id: string; snapshot_id: string; interpretation_id: string; as_of: string;
  expires_at?: string; authorized_scopes?: readonly string[] | null;
}>, nextOffset: number): Continuation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    continuation_id: `page-${String(nextOffset)}`,
    query_id: input.query_id, snapshot_id: input.snapshot_id,
    result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
    expires_at: input.expires_at ?? input.as_of,
    cursor: `offset-${String(nextOffset)}`,
    interpretation_id: input.interpretation_id, interpretation_clock: input.as_of,
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes })
  };
}

export function slotQualifiersFor(
  index: InformationIndex, proofs: readonly SourceSemanticLibraryProof[]
): SourceSemanticLibrarySlotQualifier[] {
  return index.entries.flatMap((entry, offset): SourceSemanticLibrarySlotQualifier[] => {
    if (proofForLibraryEntry(entry, proofs) === undefined) return [{ index: offset, evidence_kind: "source_evidence" }];
    return proofs.filter(row => row.source_target !== undefined && entry.target.kind === "source_evidence"
      && sourceGoldRootIdentity(row.source_target) === sourceGoldRootIdentity(entry.target))
      .map(proof => sourceSemanticProofQualifier(proof, offset));
  });
}

function mergeProofGroups(
  groups: readonly { entries: readonly IndexEntry[]; explanations?: readonly Derivation[] }[]
): { entries: IndexEntry[]; explanations: Derivation[] } {
  const entries: IndexEntry[] = [];
  const explanations: Derivation[] = [];
  const seen = new Map<string, string>();
  for (const [groupIndex, group] of groups.entries()) {
    const rename = new Map<string, string>();
    for (const row of group.explanations ?? []) {
      const existing = seen.get(row.derivation_id);
      const material = canonicalJson(row);
      if (existing !== undefined && existing !== material) {
        rename.set(row.derivation_id, `${row.derivation_id}:${String(groupIndex)}`);
      }
      seen.set(rename.get(row.derivation_id) ?? row.derivation_id, material);
    }
    const mapId = (id: string): string => rename.get(id) ?? id;
    entries.push(...group.entries.map((entry) => ({ ...entry, explanation_ids: entry.explanation_ids.map(mapId) })));
    explanations.push(...(group.explanations ?? []).map((row) => ({
      ...row, derivation_id: mapId(row.derivation_id), children: row.children.map(mapId)
    })));
  }
  return { entries, explanations };
}

function reachableExplanations(rows: readonly Derivation[], entries: readonly IndexEntry[]): Derivation[] {
  const byId = new Map(rows.map((row) => [row.derivation_id, row]));
  const keep = new Set<string>();
  const stack = entries.flatMap((entry) => entry.explanation_ids);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    keep.add(id);
    const row = byId.get(id);
    if (row !== undefined) stack.push(...row.children);
  }
  return rows.filter((row) => keep.has(row.derivation_id));
}
