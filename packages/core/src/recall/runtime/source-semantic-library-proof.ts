import {
  canonicalJson, sameRecallTarget, SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  type InformationIndex, type IndexEntry, type SourceSemanticLibraryProof,
  type SourceRecordIdentity, type SourceSemanticLibrarySlotQualifier
} from "@do-soul/alaya-protocol";
import { verifySourceSemanticSourceBinding } from "../../memory/evidence-create/source-interpretation-packet-publication.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";
import { closedProof } from "./source-semantic-delivery.js";
import { proofForLibraryEntry, sourceSemanticLibraryQueryIdentity } from "./source-semantic-library-recall.js";
import { compileSourceSemanticPremises } from "./source-semantic-premises.js";

/** Validate delivered branch correspondence using the same admission and closure owners as execution. */
export function deliveredSourceSemanticLibraryProof(
  index: InformationIndex, entry: IndexEntry, qualifier: SourceSemanticLibrarySlotQualifier,
  proofs: readonly SourceSemanticLibraryProof[],
  trustedSourceRecord?: SourceRecordIdentity
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
  let sourceRecord: ReturnType<typeof verifySourceSemanticSourceBinding>;
  try {
    sourceRecord = verifySourceSemanticSourceBinding(proof.interpretation, proof.source_target,
      proof.source_record, fieldContractSha256);
  } catch { return undefined; }
  const answer = proof.answers!.find((row) => row.binding_id === entry.output_binding)!;
  if (proof.query.alternatives[answer.alternative] === undefined
    || Object.values(answer.bindings).some((node) => node.packet_id !== proof.source_interpretation_id || node.hypothesis_id !== proof.conditional_computation_id)
    || proof.query.return_variables.some((variable) => answer.returned[variable] === undefined
      || canonicalJson(answer.returned[variable]) !== canonicalJson(answer.bindings[variable]))) return undefined;
  const admitted = admitSourceSemanticCorrespondence({ source_interpretation: proof.interpretation, query_semantics: proof.query,
    semantic_correspondence: proof.semantic_correspondence, original_query: proof.original_query });
  if (admitted.kind !== "admitted" || admitted.interpretation_id !== proof.source_interpretation_id
    || admitted.query_id !== proof.query_semantics_id || admitted.semantic_correspondence_id !== proof.semantic_correspondence_id
    || admitted.context_id !== proof.conditional_computation_id || canonicalJson(admitted.context) !== canonicalJson(proof.context)) return undefined;
  const rows = new Map((proof.derivations ?? []).map((row) => [row.derivation_id, row]));
  const delivered = new Map((index.explanations ?? []).map((row) => [row.derivation_id, row]));
  const meter = new SourceSemanticResourceLedger({ work_units: 200_000, memory_bytes: 20_000_000 });
  let population: ReturnType<typeof compileSourceSemanticPremises>;
  try {
    population = compileSourceSemanticPremises({ interpretation: admitted.interpretation, semantic_correspondence: admitted.semantic_correspondence,
      query: admitted.query, context_id: admitted.context_id, interpretation_id: admitted.interpretation_id,
      source_target: proof.source_target, scope: trustedSourceRecord.scope_class, meter, sourceValidity: sourceRecord });
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) return undefined;
    throw error;
  }
  try {
    if (!closedProof(entry.explanation_ids, rows, meter) || !closedProof(entry.explanation_ids, delivered, meter)) return undefined;
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) return undefined;
    throw error;
  }
  const leaves = new Map((proof.evidence_leaves ?? []).map((row) => [row.observation_id, row.leaf]));
  const consumed = new Set(proof.consumed_leaves.map((leaf) => canonicalJson(leaf)));
  const seen = new Set<string>(), pending = [...entry.explanation_ids];
  let observations = 0;
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = rows.get(id)!;
    if (canonicalJson(row) !== canonicalJson(delivered.get(id))) return undefined;
    for (const observation of row.observation_ids) {
      const expected = population.origins.get(observation);
      // Structural transitions and seed coordinates have no semantic leaf; the premise owner names them.
      if (expected === undefined) {
        if (!population.nodes.has(observation) && !population.rows.some((item) => item.assertionId === observation)) return undefined;
        continue;
      }
      const leaf = leaves.get(observation);
      if (leaf === undefined || canonicalJson(leaf) !== canonicalJson(expected) || !consumed.has(canonicalJson(leaf))) return undefined;
      observations += 1;
    }
    pending.push(...row.children);
  }
  return observations > 0 ? proof : undefined;
}
