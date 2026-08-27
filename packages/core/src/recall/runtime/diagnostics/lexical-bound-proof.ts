import { compareCodeUnits } from "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { freezeProducerReceipt } from "./capture-proof/lexical-bound-receipt-freeze.js";
import type { LexicalBoundProducerReceipt } from "../recall-search-port-types.js";
export type {
  LexicalBoundCandidateProvenance,
  LexicalBoundLaneCapture,
  LexicalBoundLaneHit,
  LexicalBoundLaneId,
  LexicalBoundLaneRow,
  LexicalBoundListStatus,
  LexicalBoundPostMergeRow,
  LexicalBoundProducerReceipt,
  LexicalBoundRawKeyKind,
  LexicalUnseenFrontier
} from "../recall-search-port-types.js";

export const LEXICAL_BOUND_PROOF_SCHEMA_VERSION = 1 as const;
export const LEXICAL_BOUND_PROOF_ID = "alaya.recall.lexical-bound-proof.v1";

export type LexicalBoundFieldPrefix = "lexical_relaxed" | "lexical_expanded";
export type LexicalBoundCandidateKeyDomain = "memory_object_id";

export type LexicalBoundUnavailable<Reason extends string> = Readonly<{
  readonly status: "unavailable";
  readonly reason: Reason;
}>;

export type LexicalBoundIdentityUnavailable = LexicalBoundUnavailable<string>;

export const LEXICAL_BOUND_REQUEST_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  reason: "request_not_sealed"
});
export const LEXICAL_BOUND_WORKSPACE_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  reason: "workspace_not_sealed"
});
export const LEXICAL_BOUND_SNAPSHOT_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  reason: "snapshot_not_sealed"
});
export const LEXICAL_BOUND_UNIVERSE_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  reason: "candidate_universe_not_proved"
});
export const LEXICAL_BOUND_OBSERVED_KEYS_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  reason: "proof_absent"
});
export const LEXICAL_BOUND_FIELD_PREFIX_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  reason: "field_prefix_not_sealed"
});
export const LEXICAL_BOUND_CANDIDATE_KEY_DOMAIN_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  reason: "candidate_key_domain_not_sealed"
});

export type LexicalBoundIdentitySeal = Readonly<{
  readonly request_digest: RecallFieldDigest | LexicalBoundIdentityUnavailable;
  readonly workspace_id: string | LexicalBoundIdentityUnavailable;
  readonly snapshot_digest: RecallFieldDigest | LexicalBoundIdentityUnavailable;
}>;

export type LexicalBoundProofCaptured = Readonly<{
  readonly schema_version: typeof LEXICAL_BOUND_PROOF_SCHEMA_VERSION;
  readonly proof_id: typeof LEXICAL_BOUND_PROOF_ID;
  readonly status: "captured";
  readonly receipt: LexicalBoundProducerReceipt;
  readonly observed_candidate_keys: readonly string[];
  readonly evaluated_universe: typeof LEXICAL_BOUND_UNIVERSE_UNAVAILABLE;
  readonly field_prefix: LexicalBoundFieldPrefix | LexicalBoundIdentityUnavailable;
  readonly candidate_key_domain:
    LexicalBoundCandidateKeyDomain | LexicalBoundIdentityUnavailable;
  readonly identity: LexicalBoundIdentitySeal;
  readonly proof_digest: RecallFieldDigest;
}>;

export type LexicalBoundProofAbsent = Readonly<{
  readonly schema_version: typeof LEXICAL_BOUND_PROOF_SCHEMA_VERSION;
  readonly proof_id: typeof LEXICAL_BOUND_PROOF_ID;
  readonly status: "proof_absent";
  readonly reason: "unavailable";
  readonly receipt: null;
  readonly observed_candidate_keys: typeof LEXICAL_BOUND_OBSERVED_KEYS_UNAVAILABLE;
  readonly evaluated_universe: typeof LEXICAL_BOUND_UNIVERSE_UNAVAILABLE;
  readonly field_prefix: LexicalBoundIdentityUnavailable;
  readonly candidate_key_domain: LexicalBoundIdentityUnavailable;
  readonly identity: LexicalBoundIdentitySeal;
  readonly proof_digest: RecallFieldDigest;
}>;

export type LexicalBoundProof = LexicalBoundProofCaptured | LexicalBoundProofAbsent;

export type LexicalBoundSealInput = Readonly<{
  readonly request_digest?: string;
  readonly workspace_id?: string;
  readonly snapshot_digest?: string;
  readonly field_prefix?: LexicalBoundFieldPrefix;
  readonly candidate_key_domain?: LexicalBoundCandidateKeyDomain;
}>;

export function freezeLexicalBoundProducerReceipt(
  value: unknown
): LexicalBoundProducerReceipt | undefined {
  if (value === undefined) return undefined;
  return freezeProducerReceipt(value);
}

export function freezeLexicalBoundProof(value: unknown): LexicalBoundProof | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("lexical bound proof is invalid");
  if (value.status === "proof_absent") {
    return absentLexicalBoundProof(isRecord(value.identity) ? {
      request_digest: presentDigest(value.identity.request_digest),
      workspace_id: presentWorkspace(value.identity.workspace_id),
      snapshot_digest: presentDigest(value.identity.snapshot_digest)
    } : {});
  }
  if (value.proof_id === LEXICAL_BOUND_PROOF_ID) {
    return assembleCaptured(
      freezeProducerReceipt(value.receipt),
      freezeIdentity(value.identity),
      freezeFieldPrefix(value.field_prefix),
      freezeKeyDomain(value.candidate_key_domain)
    );
  }
  return assembleCaptured(
    freezeProducerReceipt(value),
    unavailableIdentity(),
    LEXICAL_BOUND_FIELD_PREFIX_UNAVAILABLE,
    LEXICAL_BOUND_CANDIDATE_KEY_DOMAIN_UNAVAILABLE
  );
}

export function absentLexicalBoundProof(
  seal: LexicalBoundSealInput = {}
): LexicalBoundProofAbsent {
  const body = Object.freeze({
    schema_version: LEXICAL_BOUND_PROOF_SCHEMA_VERSION,
    proof_id: LEXICAL_BOUND_PROOF_ID,
    status: "proof_absent" as const,
    reason: "unavailable" as const,
    receipt: null,
    observed_candidate_keys: LEXICAL_BOUND_OBSERVED_KEYS_UNAVAILABLE,
    evaluated_universe: LEXICAL_BOUND_UNIVERSE_UNAVAILABLE,
    field_prefix: LEXICAL_BOUND_FIELD_PREFIX_UNAVAILABLE,
    candidate_key_domain: LEXICAL_BOUND_CANDIDATE_KEY_DOMAIN_UNAVAILABLE,
    identity: sealedIdentity(seal, unavailableIdentity())
  });
  return Object.freeze({
    ...body,
    proof_digest: digestRecallFieldIdentity(body)
  });
}

export function sealLexicalBoundProof(
  proof: LexicalBoundProof,
  seal: LexicalBoundSealInput
): LexicalBoundProof {
  if (proof.status !== "captured") return absentLexicalBoundProof(seal);
  return assembleCaptured(
    proof.receipt,
    sealedIdentity(seal, proof.identity),
    presentFieldPrefix(seal.field_prefix) ?? proof.field_prefix,
    presentKeyDomain(seal.candidate_key_domain) ?? proof.candidate_key_domain
  );
}

export function verifyLexicalBoundProof(proof: LexicalBoundProof): void {
  const rebuilt = freezeLexicalBoundProof(proof);
  if (rebuilt === undefined || rebuilt.proof_digest !== proof.proof_digest) {
    throw new Error("lexical bound proof digest mismatch");
  }
}

function assembleCaptured(
  receipt: LexicalBoundProducerReceipt,
  identity: LexicalBoundIdentitySeal,
  fieldPrefix: LexicalBoundFieldPrefix | LexicalBoundIdentityUnavailable,
  keyDomain: LexicalBoundCandidateKeyDomain | LexicalBoundIdentityUnavailable
): LexicalBoundProofCaptured {
  const body = Object.freeze({
    schema_version: LEXICAL_BOUND_PROOF_SCHEMA_VERSION,
    proof_id: LEXICAL_BOUND_PROOF_ID,
    status: "captured" as const,
    receipt,
    observed_candidate_keys: observedCandidateKeys(receipt),
    evaluated_universe: LEXICAL_BOUND_UNIVERSE_UNAVAILABLE,
    field_prefix: fieldPrefix,
    candidate_key_domain: keyDomain,
    identity
  });
  return Object.freeze({
    ...body,
    proof_digest: digestRecallFieldIdentity(body)
  });
}

function freezeIdentity(value: unknown): LexicalBoundIdentitySeal {
  if (value === undefined) return unavailableIdentity();
  if (!isRecord(value)) throw new TypeError("lexical bound identity is invalid");
  return Object.freeze({
    request_digest: freezeSealed(
      value.request_digest, presentDigest, "lexical bound digest identity is invalid"
    ),
    workspace_id: freezeSealed(
      value.workspace_id, presentWorkspace, "lexical bound workspace identity is invalid"
    ),
    snapshot_digest: freezeSealed(
      value.snapshot_digest, presentDigest, "lexical bound digest identity is invalid"
    )
  });
}

function freezeFieldPrefix(
  value: unknown
): LexicalBoundFieldPrefix | LexicalBoundIdentityUnavailable {
  return value === undefined
    ? LEXICAL_BOUND_FIELD_PREFIX_UNAVAILABLE
    : freezeSealed(value, presentFieldPrefix, "lexical bound field_prefix is invalid");
}

function freezeKeyDomain(
  value: unknown
): LexicalBoundCandidateKeyDomain | LexicalBoundIdentityUnavailable {
  return value === undefined
    ? LEXICAL_BOUND_CANDIDATE_KEY_DOMAIN_UNAVAILABLE
    : freezeSealed(value, presentKeyDomain, "lexical bound candidate_key_domain is invalid");
}

function freezeSealed<T>(
  value: unknown,
  present: (value: unknown) => T | undefined,
  invalid: string
): T | LexicalBoundIdentityUnavailable {
  if (isUnavailable(value)) {
    return Object.freeze({ status: "unavailable" as const, reason: value.reason });
  }
  const next = present(value);
  if (next === undefined) throw new TypeError(invalid);
  return next;
}

function sealedIdentity(
  seal: LexicalBoundSealInput,
  previous: LexicalBoundIdentitySeal
): LexicalBoundIdentitySeal {
  return Object.freeze({
    request_digest: presentDigest(seal.request_digest) ?? previous.request_digest,
    workspace_id: presentWorkspace(seal.workspace_id) ?? previous.workspace_id,
    snapshot_digest: presentDigest(seal.snapshot_digest) ?? previous.snapshot_digest
  });
}

function unavailableIdentity(): LexicalBoundIdentitySeal {
  return Object.freeze({
    request_digest: LEXICAL_BOUND_REQUEST_UNAVAILABLE,
    workspace_id: LEXICAL_BOUND_WORKSPACE_UNAVAILABLE,
    snapshot_digest: LEXICAL_BOUND_SNAPSHOT_UNAVAILABLE
  });
}

function observedCandidateKeys(receipt: LexicalBoundProducerReceipt): readonly string[] {
  return Object.freeze([...new Set(
    receipt.lanes.flatMap((lane) => lane.rows.map((row) => row.candidate_key))
  )].sort(compareCodeUnits));
}

function presentDigest(value: unknown): RecallFieldDigest | undefined {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)
    ? value as RecallFieldDigest
    : undefined;
}

function presentWorkspace(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function presentFieldPrefix(value: unknown): LexicalBoundFieldPrefix | undefined {
  return value === "lexical_relaxed" || value === "lexical_expanded" ? value : undefined;
}

function presentKeyDomain(value: unknown): LexicalBoundCandidateKeyDomain | undefined {
  return value === "memory_object_id" ? value : undefined;
}

function isUnavailable(value: unknown): value is LexicalBoundIdentityUnavailable {
  return isRecord(value) && value.status === "unavailable" &&
    typeof value.reason === "string" && value.reason.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
