import type {
  SelectGammaBinding,
  SelectGammaDecisionReceipt,
  SelectGammaFormulaCandidate,
  SelectGammaIdentityPolicy
} from "../types.js";

export type IdentityAdmission = Readonly<{
  readonly policy: SelectGammaIdentityPolicy;
  readonly retainedByObjectKey: Map<string, string>;
  readonly retainedBySourceKey: Map<string, string>;
}>;

export function resolveIdentityPolicy(
  binding: SelectGammaBinding
): SelectGammaIdentityPolicy {
  return binding.source_hard_dedupe === false
    ? "object_only"
    : "source_hard_dedupe";
}

export function createIdentityAdmission(
  policy: SelectGammaIdentityPolicy
): IdentityAdmission {
  return {
    policy,
    retainedByObjectKey: new Map<string, string>(),
    retainedBySourceKey: new Map<string, string>()
  };
}

export function rejectDuplicateIdentity(
  candidate: SelectGammaFormulaCandidate,
  identity: IdentityAdmission
): SelectGammaDecisionReceipt | null {
  const objectRetained = identity.retainedByObjectKey.get(candidate.object_key);
  if (objectRetained !== undefined) {
    return duplicateReceipt("object", objectRetained);
  }
  if (identity.policy !== "source_hard_dedupe") return null;
  const sourceRetained = retainedSource(candidate, identity.retainedBySourceKey);
  return sourceRetained === null
    ? null
    : duplicateReceipt("source", sourceRetained);
}

export function retainAdmittedIdentity(
  candidate: SelectGammaFormulaCandidate,
  identity: IdentityAdmission
): void {
  identity.retainedByObjectKey.set(candidate.object_key, candidate.candidate_key);
  if (identity.policy !== "source_hard_dedupe") return;
  if (candidate.source.status === "available") {
    identity.retainedBySourceKey.set(candidate.source.key, candidate.candidate_key);
  }
}

function retainedSource(
  candidate: SelectGammaFormulaCandidate,
  retainedBySourceKey: ReadonlyMap<string, string>
): string | null {
  return candidate.source.status === "available"
    ? retainedBySourceKey.get(candidate.source.key) ?? null
    : null;
}

function duplicateReceipt(
  identityChannel: "object" | "source",
  retainedCandidateKey: string
): SelectGammaDecisionReceipt {
  return Object.freeze({
    kind: "duplicate",
    identity_channel: identityChannel,
    retained_candidate_key: retainedCandidateKey
  });
}
