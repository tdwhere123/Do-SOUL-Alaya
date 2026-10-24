import {
  canonicalJson, sameRecallTarget, sourceEvidenceRootTarget, sourceSemanticContextIdentity, SourceSemanticResourceLedger,
  ORDINARY_NATIVE_FIELD_RESULT_VERSION, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, SOURCE_SEMANTIC_REASONING_CONTRACT,
  type InformationIndex, type IndexEntry, type SourceSemanticLibraryProof,
  type SourceRecordIdentity, type SourceSemanticLibrarySlotQualifier, type RequestBudget
} from "@do-soul/alaya-protocol";
import { verifySourceSemanticSourceBinding } from "../../memory/evidence-create/source-interpretation-packet-publication.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { compileConditionalFieldQuery, digestOriginalQuery, type OrdinaryLanguageCompileInput } from "../conditional-field/query/compile-query.js";
import { proofForLibraryEntry, proofForLibraryQualifier, scopeSourceSemanticLibraryBranch, sourceSemanticLibraryQueryIdentity } from "./source-semantic-library-recall.js";
import { executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET } from "./source-semantic-reasoning.js";
import { sourceSemanticSupportExtent } from "../../memory/evidence-create/source-semantic-support-window.js";

/** Trusted request/source facts the verifier cannot derive from the delivered page
 * itself. `compile_input` is the request the field page was compiled from, and
 * `source_body_bytes` is the current body extent from the same authoritative source
 * store that supplied `trustedSourceRecord`. Neither is response metadata. */
export type DeliveredProofTrust = Readonly<{
  readonly compile_input?: Omit<OrdinaryLanguageCompileInput, "memory" | "relations" | "query_id">;
  readonly source_body_bytes?: number;
}>;

/** Reproduce the actual accepting witness; missing proof means unverified, including exhaustion. Usage is this verification's logical cost. */
export function deliveredSourceSemanticLibraryProof(
  index: InformationIndex, entry: IndexEntry, qualifier: SourceSemanticLibrarySlotQualifier,
  proofs: readonly SourceSemanticLibraryProof[],
  trustedSourceRecord?: SourceRecordIdentity,
  verificationBudget: RequestBudget = SOURCE_SEMANTIC_REASONING_BUDGET,
  trust: DeliveredProofTrust = {}
): { proof: SourceSemanticLibraryProof | undefined; verified_proofs: readonly SourceSemanticLibraryProof[];
  resource_usage: { work_units: number; memory_bytes: number } } {
  const meter = new SourceSemanticResourceLedger(verificationBudget);
  let proof: SourceSemanticLibraryProof | undefined;
  let verified_proofs: readonly SourceSemanticLibraryProof[] = [];
  try {
    const representative = proofForLibraryEntry(entry, proofs);
    const selected = proofForLibraryQualifier(entry, qualifier, proofs);
    const fieldFamily = index.result_version === ORDINARY_NATIVE_FIELD_RESULT_VERSION;
    if (selected !== undefined && entry.target.kind === "source_evidence"
      && selected.source_target !== undefined
      && sameRecallTarget(sourceEvidenceRootTarget(selected.source_target), sourceEvidenceRootTarget(entry.target))) {
      const witnesses = qualifier.witnesses ?? [];
      const witnessOk = witnesses.length > 0
        && new Set(witnesses.map(row => canonicalJson(row))).size === witnesses.length;
      // A field page delivers the source slot, not a proof entry. Its qualifier is
      // the binding to the side proof; verification still reproduces that proof and
      // requires the delivered visible interval to expose its own support text.
      const verified = representative === undefined
        ? fieldFamily && witnessOk && entry.target.span !== undefined
          && verifyDeliveredProof(index, entry, selected, trustedSourceRecord, verificationBudget, meter, trust)
        : witnessOk
          && verifyDeliveredProof(index, entry, selected, trustedSourceRecord, verificationBudget, meter, trust)
          && (selected === representative
            || verifyDeliveredProof(index, entry, representative, trustedSourceRecord, verificationBudget, meter, trust));
      if (verified) {
        proof = selected; verified_proofs = [selected];
      }
    }
  }
  catch { /* Invalid or exhausted evidence remains unverified; retain the cost already incurred. */ }
  return { proof, verified_proofs, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } };
}

function verifyDeliveredProof(index: InformationIndex, entry: IndexEntry, proof: SourceSemanticLibraryProof,
  trustedSourceRecord: SourceRecordIdentity | undefined,
  verificationBudget: RequestBudget, meter: SourceSemanticResourceLedger,
  trust: DeliveredProofTrust): SourceSemanticLibraryProof | undefined {
  const fieldFamily = index.result_version === ORDINARY_NATIVE_FIELD_RESULT_VERSION;
  meter.retain([proof, entry], "delivered proof envelope");
  if (!["interpreted", "resource_exhausted"].includes(proof.outcome.status) || (proof.binding_results?.length ?? 0) === 0
    || proof.source_target === undefined
    || (!fieldFamily && index.query_id !== sourceSemanticLibraryQueryIdentity(proof.original_query))
    || proof.source_target.source_version !== proof.interpretation.source.source_version
    || proof.source_target.content_digest !== proof.interpretation.source.content_digest) return undefined;
  // The field page's own query identity must be the identity of the trusted request
  // it was compiled from, and that request must be this proof's original query.
  // Re-executing the proof's own query is not a binding to the delivered page.
  if (fieldFamily && !fieldRequestBindsProof(index, proof, trust, meter)) return undefined;
  // Field delivery has no proof entry to bind: the visible source interval is the
  // claim's only exposure, so an absent span can never be verified.
  if (fieldFamily && (entry.target.kind !== "source_evidence" || entry.target.span === undefined)) return undefined;
  if (trustedSourceRecord === undefined || trustedSourceRecord.scope_class == null
    || canonicalJson(trustedSourceRecord) !== canonicalJson(proof.source_record)) return undefined;
  const sourceRecord = verifySourceSemanticSourceBinding(proof.interpretation, proof.source_target,
    proof.source_record, fieldContractSha256);
  if (index.as_of === undefined) return undefined;
  const executed = executeSourceSemanticInterpretation({
    computation: { contract: SOURCE_SEMANTIC_REASONING_CONTRACT, accepts_unreviewed_conditional_results: true,
      source_interpretation_id: proof.source_interpretation_id!, query_semantics_id: proof.query_semantics_id!,
      semantic_correspondence_id: proof.semantic_correspondence_id!, original_query: proof.original_query,
      budget: { ...verificationBudget, ...meter.remaining() } },
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
    } else if (required.reason !== "location_missing") {
      return undefined;
    } else if (!fullBodyExposed(span, trust.source_body_bytes)) return undefined;
  }
  // The field and library namespaces both author their branch through the same
  // scoped namespace owner; comparing unscoped local-leaf ids against a scoped
  // proof is not the same witness.
  const branch = fieldFamily || index.result_version === SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION
    ? scopeSourceSemanticLibraryBranch(executed.index, executed.result)
    : index.result_version === SOURCE_SEMANTIC_REASONING_CONTRACT ? { ...executed, index: executed.index } : undefined;
  if (branch === undefined) return undefined;
  const expected = branch;
  if (canonicalJson(proof.evaluation ?? null) !== canonicalJson(expected.result.evaluation ?? null)
    || canonicalJson(proof.derived_nodes ?? []) !== canonicalJson(expected.result.derived_nodes ?? [])) return undefined;
  // A field page does not carry the proof's derivation forest; the reproducible
  // comparison then uses the executed branch as the expected witness.
  const witnessForest = fieldFamily ? expected.index : index;
  for (const binding of proof.binding_results ?? []) {
    const actual = expected.result.binding_results?.find(row => row.binding_id === binding.binding_id);
    const witness = expected.index.entries.find(row => row.output_binding === binding.binding_id);
    if (actual === undefined || witness === undefined || canonicalJson(binding) !== canonicalJson(actual)
      || !sameRecallTarget(witness.target, proof.source_target)) return undefined;
    if (!fieldFamily && proof.conditional_computation_id === entry.hypothesis_id && binding.binding_id === entry.output_binding
      && (canonicalJson(witness.interpretation_node) !== canonicalJson(entry.interpretation_node)
        || canonicalJson(witness.explanation_ids) !== canonicalJson(entry.explanation_ids))) return undefined;
    if (!matchesExecutionWitness(witnessForest, witness, proof, expected.result, meter)) return undefined;
  }
  return proof;
}

/** Bind the delivered field page to the trusted request it was compiled from, and
 * that request to this proof's own original query. The field query identity is
 * Core's compiled identity of the request, so a page carrying another query's id
 * is not this request's premise. Absent trusted request input stays unverified. */
function fieldRequestBindsProof(index: InformationIndex, proof: SourceSemanticLibraryProof,
  trust: DeliveredProofTrust, meter: SourceSemanticResourceLedger): boolean {
  const compileInput = trust.compile_input;
  if (compileInput === undefined) return false;
  meter.charge(1, 0, "field request binding");
  const requestQueryId = compileConditionalFieldQuery({ ...compileInput, source: "ordinary" }).query_id;
  if (requestQueryId !== index.query_id) return false;
  return digestOriginalQuery(compileInput.text) === proof.query.original_query_digest;
}

/** A missing-location support claim is only satisfied by the whole authoritative body.
 * The delivered interval must match the same source store's body extent; the producer's
 * `content_complete` Boolean cannot attest that by itself, and an unknown body extent
 * cannot be replaced by a guessed length or a self-declared span. */
function fullBodyExposed(span: Readonly<{ content_start: number; content_end: number; content_complete: boolean }>,
  bodyBytes: number | undefined): boolean {
  if (bodyBytes === undefined || !Number.isSafeInteger(bodyBytes) || bodyBytes < 0) return false;
  return span.content_start === 0 && span.content_end === bodyBytes && span.content_complete;
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
