import {
  canonicalJson, sameRecallTarget, sourceEvidenceRootTarget, sourceSemanticContextIdentity, SourceSemanticResourceLedger,
  SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, SOURCE_SEMANTIC_REASONING_CONTRACT,
  type InformationIndex, type IndexEntry, type SourceSemanticLibraryProof,
  type SourceRecordIdentity, type SourceSemanticLibrarySlotQualifier, type RequestBudget
} from "@do-soul/alaya-protocol";
import { verifySourceSemanticSourceBinding } from "../../memory/evidence-create/source-interpretation-packet-publication.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { proofForLibraryEntry, scopeSourceSemanticLibraryBranch, sourceSemanticLibraryQueryIdentity, sourceGoldRootIdentity } from "./source-semantic-library-recall.js";
import { executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET } from "./source-semantic-reasoning.js";
import { projectSourceSemanticQuerySupport } from "./source-semantic-query-support.js";
import { sourceSemanticSupportExtent } from "../../memory/evidence-create/source-semantic-support-window.js";

/** Reproduce the actual accepting witness; missing proof means unverified, including exhaustion. Usage is this verification's logical cost. */
export function deliveredSourceSemanticLibraryProof(
  index: InformationIndex, entry: IndexEntry, qualifier: SourceSemanticLibrarySlotQualifier,
  proofs: readonly SourceSemanticLibraryProof[],
  trustedSourceRecord?: SourceRecordIdentity,
  verificationBudget: RequestBudget = SOURCE_SEMANTIC_REASONING_BUDGET
): { proof: SourceSemanticLibraryProof | undefined; verified_proofs: readonly SourceSemanticLibraryProof[];
  resource_usage: { work_units: number; memory_bytes: number } } {
  const meter = new SourceSemanticResourceLedger(verificationBudget);
  let proof: SourceSemanticLibraryProof | undefined;
  let verified_proofs: readonly SourceSemanticLibraryProof[] = [];
  try {
    const representative = proofForLibraryEntry(entry, proofs);
    if (representative !== undefined && entry.target.kind === "source_evidence" && qualifier.evidence_kind === "semantic_proof"
      && representative.source_target !== undefined
      && sameRecallTarget(sourceEvidenceRootTarget(representative.source_target), sourceEvidenceRootTarget(entry.target))
      && qualifier.source_interpretation_id === representative.source_interpretation_id
      && qualifier.query_semantics_id === representative.query_semantics_id
      && qualifier.semantic_correspondence_id === representative.semantic_correspondence_id
      && qualifier.conditional_computation_id === representative.conditional_computation_id) {
      const root = sourceGoldRootIdentity(entry.target);
      const claims = proofs.filter(row => row.source_target !== undefined && sourceGoldRootIdentity(row.source_target) === root);
      const witnesses = claims.flatMap(row => (row.binding_results ?? []).map(binding => ({
        conditional_computation_id: row.conditional_computation_id, binding_id: binding.binding_id
      })));
      if (witnesses.length > 0 && canonicalJson(witnesses) === canonicalJson(qualifier.witnesses)
        && new Set(witnesses.map(row => canonicalJson(row))).size === witnesses.length
        && claims.every(row => row.query_semantics_id === representative.query_semantics_id)
        && canonicalJson(qualifier.support) === canonicalJson(projectSourceSemanticQuerySupport(representative.query,
          claims.flatMap(row => row.binding_results ?? [])))
        && claims.every(row => verifyDeliveredProof(index, entry, row, trustedSourceRecord, verificationBudget, meter))) {
        proof = representative; verified_proofs = claims;
      }
    }
  }
  catch { /* Invalid or exhausted evidence remains unverified; retain the cost already incurred. */ }
  return { proof, verified_proofs, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } };
}

function verifyDeliveredProof(index: InformationIndex, entry: IndexEntry, proof: SourceSemanticLibraryProof,
  trustedSourceRecord: SourceRecordIdentity | undefined,
  verificationBudget: RequestBudget, meter: SourceSemanticResourceLedger): SourceSemanticLibraryProof | undefined {
  meter.retain([proof, entry], "delivered proof envelope");
  if (!["interpreted", "resource_exhausted"].includes(proof.outcome.status) || (proof.binding_results?.length ?? 0) === 0
    || proof.source_target === undefined
    || index.query_id !== sourceSemanticLibraryQueryIdentity(proof.original_query)
    || proof.source_target.source_version !== proof.interpretation.source.source_version
    || proof.source_target.content_digest !== proof.interpretation.source.content_digest) return undefined;
  if (trustedSourceRecord === undefined || trustedSourceRecord.scope_class == null
    || canonicalJson(trustedSourceRecord) !== canonicalJson(proof.source_record)) return undefined;
  const sourceRecord = verifySourceSemanticSourceBinding(proof.interpretation, proof.source_target,
    proof.source_record, fieldContractSha256);
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
  if (entry.target.kind === "source_evidence" && entry.target.span !== undefined) {
    const span = entry.target.span;
    const required = sourceSemanticSupportExtent(proof.interpretation, executed.source_dependencies ?? [], meter);
    if (span.retained_extent !== "body") return undefined;
    if (required.status === "located") {
      if (span.content_start > required.start || span.content_end < required.end) return undefined;
    } else if (required.reason !== "location_missing" || !span.content_complete || span.content_start !== 0) return undefined;
  }
  const expected = index.result_version === SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION
    ? scopeSourceSemanticLibraryBranch(executed.index, executed.result)
    : index.result_version === SOURCE_SEMANTIC_REASONING_CONTRACT ? { ...executed, index: executed.index } : undefined;
  if (expected === undefined) return undefined;
  if (canonicalJson(proof.evaluation ?? null) !== canonicalJson(expected.result.evaluation ?? null)
    || canonicalJson(proof.derived_nodes ?? []) !== canonicalJson(expected.result.derived_nodes ?? [])) return undefined;
  for (const binding of proof.binding_results ?? []) {
    const actual = expected.result.binding_results?.find(row => row.binding_id === binding.binding_id);
    const witness = expected.index.entries.find(row => row.output_binding === binding.binding_id);
    if (actual === undefined || witness === undefined || canonicalJson(binding) !== canonicalJson(actual)
      || !sameRecallTarget(witness.target, proof.source_target)) return undefined;
    if (proof.conditional_computation_id === entry.hypothesis_id && binding.binding_id === entry.output_binding
      && (canonicalJson(witness.interpretation_node) !== canonicalJson(entry.interpretation_node)
        || canonicalJson(witness.explanation_ids) !== canonicalJson(entry.explanation_ids))) return undefined;
    if (!matchesExecutionWitness(index, witness, proof, expected.result, meter)) return undefined;
  }
  return proof;
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
