import {
  canonicalJson, CONDITIONAL_FIELD_SCHEMA_VERSION, InformationIndexSchema, MILLIGRADE_TOP,
  SOURCE_SEMANTIC_LIBRARY_OCCUPANCY, SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_LIBRARY_TIE_POLICY, sourceIndexEntry, indexEntryCacheKey, indexEntryObjectKind,
  indexMemoryObjectId, type Continuation, type Derivation, type IndexEntry, type InformationIndex, type MemorySearchResult,
  type SourceEvidenceTarget, type SourceSemanticLibraryOrder, type SourceSemanticLibrarySlotQualifier,
  SoulInterpretationResponseSchema, type SourceSemanticWorkerResult, type SoulInterpretationResponse,
  type SourceSemanticReasoningResult
} from "@do-soul/alaya-protocol";
import { sortIndexEntries } from "./index-continuation.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";

/** Offline evidence binds its recorded result contract; live requests use the current version. */
export function sourceSemanticLibraryQueryIdentity(originalQuery: string, resultVersion: string = SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION): string {
  return `sha256:${fieldContractSha256(canonicalJson({ kind: resultVersion, query: originalQuery }))}`;
}

export const SOURCE_SEMANTIC_LIBRARY_ORDER: SourceSemanticLibraryOrder = {
  enumeration_policy: "canonical",
  tie_policy: SOURCE_SEMANTIC_LIBRARY_TIE_POLICY,
  occupancy: SOURCE_SEMANTIC_LIBRARY_OCCUPANCY,
  occupancy_prefix: SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX,
  page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET
};

/** Gold-join occupancy key. Omits evidence_object_id, hypothesis, binding, and interpretation node. */
export function sourceGoldRootIdentity(target: SourceEvidenceTarget): string {
  return canonicalJson({
    workspace_id: target.workspace_id, root_kind: target.root_kind, root_id: target.root_id,
    source_version: target.source_version, content_digest: target.content_digest
  });
}

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
  const proved = new Set((result.answers ?? []).map((row) => row.binding_id));
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
    result: { ...result, answers: result.answers?.map((row) => ({ ...row, explanation_ids: row.explanation_ids.map(id) })),
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
    preferred.push(proof ?? ranked[0]!);
    omitted += ranked.length - 1;
  }
  const occupied = sortIndexEntries(preferred, "canonical");
  const offset = Math.max(0, input.offset ?? 0);
  const page = occupied.slice(offset, offset + SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
  const occupancyRemaining = occupied.length > offset + page.length;
  const remaining = occupancyRemaining || input.open_residuals || input.truncated;
  const explanations = reachableExplanations(merged.explanations, page);
  const nextOffset = offset + page.length;
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
        order_coverage: "complete", pending_computation: remaining ? "open" : "complete"
      },
      continuation: occupancyRemaining ? libraryOccupancyContinuation(input, nextOffset) : null,
      representation: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        policy: "construct_index_then_page_then_payload",
        page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
        identity_tie_break: "serialization"
      },
      order_status: remaining ? "open" : "complete",
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
    enumeration_policy: "canonical",
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes })
  };
}

export function encodeSourceSemanticLibraryResults(
  index: InformationIndex,
  previews: ReadonlyMap<string, string> = new Map(),
  maxTotalTokens = 2_000
): MemorySearchResult[] {
  const encoded: MemorySearchResult[] = [];
  let usedTokens = 0;
  for (const [offset, entry] of index.entries.entries()) {
    if (offset >= index.representation.page_budget) break;
    const score = entry.association_milligrades / MILLIGRADE_TOP;
    const cacheKey = indexEntryCacheKey(entry);
    const objectId = indexMemoryObjectId(entry);
    const preview = previews.get(cacheKey) ?? (objectId === undefined ? undefined : previews.get(objectId)) ?? "[payload omitted]";
    const tokenEstimate = Math.min(preview.length, Math.max(0, maxTotalTokens - usedTokens));
    usedTokens += tokenEstimate;
    const omitted = tokenEstimate === 0 && preview.length > 0;
    const content = omitted ? "[payload omitted]" : preview.slice(0, Math.max(tokenEstimate, 0));
    const proof = entry.interpretation_node !== undefined && entry.explanation_ids.length > 0;
    encoded.push({
      ...(objectId === undefined ? {} : { object_id: objectId }),
      object_kind: indexEntryObjectKind(entry),
      target: entry.target,
      relevance_score: score,
      content_preview: content.length === 0 ? "[empty source]" : content,
      evidence_pointers: [],
      hypothesis_id: entry.hypothesis_id,
      program_state: entry.program_state ?? "accepting",
      time_state: entry.time_state ?? "as_of",
      output_binding: entry.output_binding,
      selection_reason: proof
        ? `Conditional on interpretation ${entry.interpretation_node!.packet_id}; claim unknown.`
        : "Source evidence without a proved semantic answer; claim unknown.",
      source_channels: proof ? ["conditional_field"] : ["source_record"],
      score_factors: { activation: score, relevance: score },
      budget_state: {
        token_estimate: tokenEstimate,
        max_entries: index.representation.page_budget,
        max_total_tokens: maxTotalTokens,
        remaining_entries: Math.max(0, index.representation.page_budget - encoded.length - 1),
        remaining_tokens: Math.max(0, maxTotalTokens - usedTokens),
        within_budget: !omitted && tokenEstimate === preview.length
      }
    });
  }
  return encoded;
}

/** The worker's byte check and MCP delivery encode the exact same public envelope. */
export function encodeSourceSemanticLibraryResponse(
  result: Extract<SourceSemanticWorkerResult, { kind: "recall" }>
): SoulInterpretationResponse {
  const { kind: _kind, previews, coverage, ...rest } = result;
  const results = encodeSourceSemanticLibraryResults(result.index, new Map(Object.entries(previews ?? {})));
  const omitted = results.some((row) => row.content_preview === "[payload omitted]" || !row.budget_state.within_budget);
  return SoulInterpretationResponseSchema.parse({ operation: "recall", ...rest, results,
    total_count: results.length, provider_attempts: 0,
    index: omitted ? { ...result.index, completeness: { ...result.index.completeness, payload: "partial" } } : result.index,
    coverage: { ...coverage, payload: omitted ? "truncated" : coverage.payload } });
}

export function proofForLibraryEntry<T extends SourceSemanticReasoningResult>(
  entry: IndexEntry, proofs: readonly T[]
): T | undefined {
  if (entry.interpretation_node === undefined || entry.explanation_ids.length === 0) return undefined;
  return proofs.find((row) => row.source_interpretation_id === entry.interpretation_node!.packet_id
    && row.conditional_computation_id === entry.hypothesis_id
    && (row.answers ?? []).some((answer) => answer.binding_id === entry.output_binding
      && canonicalJson(answer.explanation_ids) === canonicalJson(entry.explanation_ids)));
}

export function slotQualifiersFor(
  index: InformationIndex, proofs: readonly SourceSemanticReasoningResult[]
): SourceSemanticLibrarySlotQualifier[] {
  return index.entries.map((entry, offset) => {
    const proof = proofForLibraryEntry(entry, proofs);
    if (proof === undefined) return { index: offset, evidence_kind: "source_evidence" as const };
    return {
      index: offset, evidence_kind: "semantic_proof" as const,
      ...(proof.source_interpretation_id === undefined ? {} : { source_interpretation_id: proof.source_interpretation_id }),
      ...(proof.query_semantics_id === undefined ? {} : { query_semantics_id: proof.query_semantics_id }),
      ...(proof.semantic_correspondence_id === undefined ? {} : { semantic_correspondence_id: proof.semantic_correspondence_id }),
      ...(proof.conditional_computation_id === undefined ? {} : { conditional_computation_id: proof.conditional_computation_id })
    };
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
