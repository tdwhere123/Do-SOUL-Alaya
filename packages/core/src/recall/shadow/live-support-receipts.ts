import {
  digestCanonicalQueryV1,
  type CanonicalQueryCompilationV1,
  type CanonicalQueryV1
} from "../query/canonical-query/index.js";
import {
  buildRecallCandidateDedupeKey,
  isWorkspaceMemoryCandidate
} from "../runtime/recall-service-helpers.js";
import type { CoarseRecallCandidate, RecallSupplementaryData } from
  "../runtime/recall-service-types.js";
import { stableStringify } from "../../shared/stable-stringify.js";
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

export function bindLiveSupportHypothesisDigest(
  compilation: Pick<CanonicalQueryCompilationV1, "hypotheses">,
  receipt: SupportCandidateReceiptV1
): string | undefined {
  const matched = compilation.hypotheses.filter((hypothesis) =>
    receiptBindsHypothesis(receipt, hypothesis));
  if (matched.length !== 1) return undefined;
  return digestCanonicalQueryV1(matched[0]!);
}

export function supportReceiptBindsCurrentQuery(
  receipt: SupportCandidateReceiptV1,
  compilation: Pick<CanonicalQueryCompilationV1, "hypotheses">
): boolean {
  const bound = bindLiveSupportHypothesisDigest(compilation, receipt);
  return bound !== undefined && bound === receipt.hypothesis_digest;
}

export function liveSupportReceiptsMatchProjection(
  receipts: readonly SupportCandidateReceiptV1[],
  projected: readonly SupportCandidateReceiptV1[] | undefined
): boolean {
  if (projected === undefined || projected.length !== receipts.length) return false;
  const byKey = new Map(projected.map((receipt) => [receipt.candidate_key, receipt]));
  if (byKey.size !== projected.length) return false;
  return receipts.every((receipt) => {
    const expected = byKey.get(receipt.candidate_key);
    return expected !== undefined && sameLiveSupportReceipt(receipt, expected);
  });
}

export function projectLiveSupportCandidateReceipts(
  candidates: readonly Readonly<CoarseRecallCandidate>[],
  supplementary: RecallSupplementaryData,
  compilation: Pick<CanonicalQueryCompilationV1, "hypotheses">
): readonly SupportCandidateReceiptV1[] | undefined {
  const receipts = Object.freeze(candidates.flatMap((candidate) => {
    const receipt = projectCandidateSupportReceipt(candidate, supplementary, compilation);
    return receipt === undefined ? [] : [receipt];
  }));
  return receipts.length === 0 ? undefined : receipts;
}

function projectCandidateSupportReceipt(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementary: RecallSupplementaryData,
  compilation: Pick<CanonicalQueryCompilationV1, "hypotheses">
): SupportCandidateReceiptV1 | undefined {
  const candidate_key = buildRecallCandidateDedupeKey(candidate);
  const evidence_ids = evidenceIdsFor(candidate, supplementary, candidate_key);
  const osf = projectLiveSupportOsf(
    supplementary.openSemanticFactorComposition, evidence_ids);
  if (osf === undefined && evidence_ids.length === 0) return undefined;
  const draft = Object.freeze({
    candidate_key,
    ...(osf === undefined ? {} : { osf }),
    ...(evidence_ids.length === 0 ? {} : { evidence_ids: Object.freeze([...evidence_ids]) })
  });
  const hypothesis_digest = bindLiveSupportHypothesisDigest(compilation, draft);
  if (hypothesis_digest === undefined) return undefined;
  const receipt = Object.freeze({ ...draft, hypothesis_digest });
  return supportReceiptIsPropositionLegal(receipt) ? receipt : undefined;
}

function receiptBindsHypothesis(
  receipt: SupportCandidateReceiptV1,
  hypothesis: CanonicalQueryV1
): boolean {
  const predicateIds = new Set(hypothesis.predicates.map((predicate) => predicate.id));
  const vocabulary = hypothesisVocabulary(hypothesis);
  const bindings = receipt.osf?.bindings ?? [];
  if (!bindings.some((binding) =>
    binding.query_proposition_id !== undefined &&
    predicateIds.has(binding.query_proposition_id))) {
    return false;
  }
  if (bindings.some((binding) =>
    (binding.query_proposition_id !== undefined &&
      !predicateIds.has(binding.query_proposition_id)) ||
    !vocabulary.has(binding.semantic_identity))) {
    return false;
  }
  return (receipt.fact_frames ?? []).every((frame) => vocabulary.has(frame.semantic_identity));
}

function hypothesisVocabulary(hypothesis: CanonicalQueryV1): Set<string> {
  return new Set([
    ...hypothesis.predicates.flatMap((predicate) =>
      [predicate.id, predicate.relation, ...predicate.arguments]),
    ...hypothesis.constants.map((constant) => constant.value),
    ...hypothesis.variables.map((variable) => variable.name)
  ]);
}

function sameLiveSupportReceipt(
  left: SupportCandidateReceiptV1,
  right: SupportCandidateReceiptV1
): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function supportReceiptOsfProjectsComposition(
  receipt: SupportCandidateReceiptV1,
  composition: NonNullable<RecallSupplementaryData["openSemanticFactorComposition"]>
): boolean {
  return stableStringify(receipt.osf) ===
    stableStringify(projectLiveSupportOsf(composition, receipt.evidence_ids ?? []));
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

export function projectLiveSupportOsf(
  composition: RecallSupplementaryData["openSemanticFactorComposition"],
  evidenceIds: readonly string[]
): SupportCandidateReceiptV1["osf"] | undefined {
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
