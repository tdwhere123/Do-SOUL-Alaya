import {
  canonicalJson, sameRecallTarget, sourceSemanticContextIdentity, SourceSemanticResourceLedger,
  SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, SOURCE_SEMANTIC_REASONING_CONTRACT,
  type InformationIndex, type IndexEntry, type SourceSemanticLibraryProof,
  type SourceRecordIdentity, type SourceSemanticLibrarySlotQualifier, type RequestBudget
} from "@do-soul/alaya-protocol";
import { verifySourceSemanticSourceBinding } from "../../memory/evidence-create/source-interpretation-packet-publication.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { proofForLibraryEntry, scopeSourceSemanticLibraryBranch, sourceSemanticLibraryQueryIdentity } from "./source-semantic-library-recall.js";
import { executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET } from "./source-semantic-reasoning.js";

/** Reproduce the actual accepting witness within one explicit budget; undefined means unverified, including exhaustion. */
export function deliveredSourceSemanticLibraryProof(
  index: InformationIndex, entry: IndexEntry, qualifier: SourceSemanticLibrarySlotQualifier,
  proofs: readonly SourceSemanticLibraryProof[],
  trustedSourceRecord?: SourceRecordIdentity,
  verificationBudget: RequestBudget = SOURCE_SEMANTIC_REASONING_BUDGET
): SourceSemanticLibraryProof | undefined {
  const proof = proofForLibraryEntry(entry, proofs);
  if (proof === undefined || qualifier.evidence_kind !== "semantic_proof"
    || !["interpreted", "resource_exhausted"].includes(proof.outcome.status)
    || proof.source_target === undefined || !sameRecallTarget(proof.source_target, entry.target)
    || qualifier.source_interpretation_id !== proof.source_interpretation_id || qualifier.query_semantics_id !== proof.query_semantics_id
    || qualifier.semantic_correspondence_id !== proof.semantic_correspondence_id || qualifier.conditional_computation_id !== proof.conditional_computation_id
    || index.query_id !== sourceSemanticLibraryQueryIdentity(proof.original_query)
    || proof.source_target.source_version !== proof.interpretation.source.source_version
    || proof.source_target.content_digest !== proof.interpretation.source.content_digest) return undefined;
  if (trustedSourceRecord === undefined || trustedSourceRecord.scope_class == null
    || canonicalJson(trustedSourceRecord) !== canonicalJson(proof.source_record)) return undefined;
  try {
    const sourceRecord = verifySourceSemanticSourceBinding(proof.interpretation, proof.source_target,
      proof.source_record, fieldContractSha256);
    const meter = new SourceSemanticResourceLedger(verificationBudget);
    meter.retain([proof, entry], "delivered proof envelope");
    if (index.as_of === undefined) return undefined;
    const executed = executeSourceSemanticInterpretation({
      request: { contract: SOURCE_SEMANTIC_REASONING_CONTRACT, accepts_unreviewed_conditional_results: true,
        source_interpretation_id: proof.source_interpretation_id!, query_semantics_id: proof.query_semantics_id!,
        semantic_correspondence_id: proof.semantic_correspondence_id!, original_query: proof.original_query,
        budget: { ...verificationBudget, ...meter.remaining() }, output_byte_limit: 1_000_000 },
      source_interpretation: proof.interpretation, query_semantics: proof.query, semantic_correspondence: proof.semantic_correspondence,
      workspaceId: sourceRecord.workspace_id, scope: trustedSourceRecord.scope_class,
      authorizedScopes: null, asOf: index.as_of, sourceValidity: sourceRecord, source_target: proof.source_target
    });
    const usage = executed.result.resource_usage;
    if (usage !== undefined) meter.charge(usage.work_units, usage.memory_bytes, "proof execution witness");
    if (executed.index === null || executed.result.conditional_computation_id !== proof.conditional_computation_id
      || sourceSemanticContextIdentity(proof.context, fieldContractSha256) !== proof.conditional_computation_id) return undefined;
    const expected = index.result_version === SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION
      ? scopeSourceSemanticLibraryBranch(executed.index, executed.result)
      : index.result_version === SOURCE_SEMANTIC_REASONING_CONTRACT ? { ...executed, index: executed.index } : undefined;
    if (expected === undefined) return undefined;
    const answer = proof.answers!.find((row) => row.binding_id === entry.output_binding)!;
    const actual = expected.result.answers?.find((row) => row.binding_id === entry.output_binding);
    if (actual === undefined || canonicalJson(answer) !== canonicalJson(actual)
      || canonicalJson(proof.evaluation ?? null) !== canonicalJson(expected.result.evaluation ?? null)
      || canonicalJson(proof.derived_nodes ?? []) !== canonicalJson(expected.result.derived_nodes ?? [])) return undefined;
    const expectedEntry = expected.index.entries.find((row) => row.output_binding === entry.output_binding);
    if (expectedEntry === undefined || canonicalJson(expectedEntry.interpretation_node) !== canonicalJson(entry.interpretation_node)
      || canonicalJson(expectedEntry.explanation_ids) !== canonicalJson(entry.explanation_ids)) return undefined;
    return matchesExecutionWitness(index, entry, proof, expected.result, meter) ? proof : undefined;
  } catch {
    return undefined;
  }
}

function matchesExecutionWitness(index: InformationIndex, entry: IndexEntry, proof: SourceSemanticLibraryProof,
  expected: ReturnType<typeof executeSourceSemanticInterpretation>["result"], meter: SourceSemanticResourceLedger): boolean {
  const rows = new Map((proof.derivations ?? []).map((row) => [row.derivation_id, row]));
  const delivered = new Map((index.explanations ?? []).map((row) => [row.derivation_id, row]));
  const actual = new Map((expected.derivations ?? []).map((row) => [row.derivation_id, row]));
  const leaves = new Map((proof.evidence_leaves ?? []).map((row) => [row.observation_id, row.leaf]));
  const actualLeaves = new Map((expected.evidence_leaves ?? []).map((row) => [row.observation_id, row.leaf]));
  const consumed = new Set(proof.consumed_leaves.map((leaf) => canonicalJson(leaf)));
  const seen = new Set<string>(), pending = [...entry.explanation_ids];
  let observations = 0;
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    meter.charge(1, 0, "proof witness comparison");
    const row = actual.get(id);
    if (row === undefined || canonicalJson(row) !== canonicalJson(rows.get(id))
      || canonicalJson(row) !== canonicalJson(delivered.get(id))) return false;
    for (const observation of row.observation_ids) {
      const expected = actualLeaves.get(observation);
      if (expected === undefined) continue;
      const leaf = leaves.get(observation);
      if (leaf === undefined || canonicalJson(leaf) !== canonicalJson(expected) || !consumed.has(canonicalJson(leaf))) return false;
      observations += 1;
    }
    pending.push(...row.children);
  }
  return observations > 0;
}
