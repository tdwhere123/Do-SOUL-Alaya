import {
  buildRecallCandidateDedupeKey,
  isWorkspaceMemoryCandidate
} from "../runtime/recall-service-helpers.js";
import type { CoarseRecallCandidate, RecallSupplementaryData } from
  "../runtime/recall-service-types.js";
import type { SupportCandidateReceiptV1, SupportOsfBindingV1 } from
  "./support/adapters/types.js";

const HYPOTHESIS_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function supportReceiptIsPropositionLegal(
  receipt: SupportCandidateReceiptV1
): boolean {
  if (receipt.hypothesis_digest === undefined ||
      !HYPOTHESIS_DIGEST.test(receipt.hypothesis_digest)) {
    return false;
  }
  if ((receipt.evidence_ids?.length ?? 0) > 0) return true;
  return (receipt.osf?.bindings ?? []).some((binding) =>
    typeof binding.semantic_identity === "string" &&
    binding.semantic_identity.length > 0);
}

export function projectLiveSupportCandidateReceipts(
  candidates: readonly Readonly<CoarseRecallCandidate>[],
  supplementary: RecallSupplementaryData
): readonly SupportCandidateReceiptV1[] | undefined {
  const receipts = Object.freeze(candidates.flatMap((candidate) => {
    const receipt = projectCandidateSupportReceipt(candidate, supplementary);
    return receipt === undefined ? [] : [receipt];
  }));
  return receipts.length === 0 ? undefined : receipts;
}

function projectCandidateSupportReceipt(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementary: RecallSupplementaryData
): SupportCandidateReceiptV1 | undefined {
  const candidate_key = buildRecallCandidateDedupeKey(candidate);
  const evidence_ids = evidenceIdsFor(candidate, supplementary, candidate_key);
  const osf = projectOsf(supplementary, evidence_ids);
  if (osf === undefined && evidence_ids.length === 0) return undefined;
  const receipt = Object.freeze({
    candidate_key,
    ...(osf === undefined ? {} : { osf }),
    ...(evidence_ids.length === 0 ? {} : { evidence_ids: Object.freeze([...evidence_ids]) })
  });
  return supportReceiptIsPropositionLegal(receipt) ? receipt : undefined;
}

function evidenceIdsFor(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementary: RecallSupplementaryData,
  candidateKey: string
): readonly string[] {
  const attributed = supplementary.openSemanticFactorCandidateActivationsByCandidateKey
    ?.get(candidateKey)?.evidence_ids;
  if (attributed !== undefined && attributed.length > 0) return attributed;
  if (candidate.objectKind === "evidence_capsule") return [candidate.entry.object_id];
  if (!isWorkspaceMemoryCandidate(candidate)) return [];
  return [...new Set(candidate.entry.evidence_refs)];
}

function projectOsf(
  supplementary: RecallSupplementaryData,
  evidenceIds: readonly string[]
): SupportCandidateReceiptV1["osf"] | undefined {
  const composition = supplementary.openSemanticFactorComposition;
  if (composition === undefined) return undefined;
  const allowed = new Set(evidenceIds);
  const bindings = Object.freeze((composition.bindings ?? [])
    .filter((binding) => allowed.has(binding.evidence_id))
    .map(copyOsfBinding)
    .filter((binding): binding is SupportOsfBindingV1 => binding !== undefined));
  return Object.freeze({
    composition_status: composition.status,
    truncated: composition.truncated,
    ...(bindings.length === 0 ? {} : { bindings })
  });
}

function copyOsfBinding(
  binding: NonNullable<RecallSupplementaryData["openSemanticFactorComposition"]>["bindings"][number]
): SupportOsfBindingV1 | undefined {
  if (binding.semantic_identity.length === 0) return undefined;
  return Object.freeze({
    variable_id: binding.variable_id,
    binding_identity: binding.binding_identity,
    semantic_identity: binding.semantic_identity,
    evidence_id: binding.evidence_id,
    query_proposition_id: binding.query_proposition_id
  });
}
