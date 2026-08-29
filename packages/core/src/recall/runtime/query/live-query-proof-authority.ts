import type { QueryConditionReceipt } from "@do-soul/alaya-protocol";
import {
  verifyCanonicalQueryCompilationV1,
  type CanonicalQueryCompilationV1,
  type CanonicalQueryEvidenceV1
} from
  "../../query/canonical-query/index.js";
import type { LexicalRequestPin } from
  "../../field/retrieval/retrieval-field-bundle.js";
import { digestRecallFieldIdentity } from "../../field/field-identity.js";
import {
  freezeLexicalBoundProof,
  verifyLexicalBoundProof,
  type LexicalBoundProof
} from "../diagnostics/lexical-bound-proof.js";
import {
  verifySnapshotCoherenceReceiptV1,
  verifySnapshotVectorV1,
  finalizePreparedSnapshotReadLease,
  type SnapshotCoherenceReceiptV1,
  type SnapshotReadLeaseV1,
  type SnapshotVectorV1
} from "../snapshot-coherence/index.js";

export type LiveQueryProofAuthority = Readonly<{
  readonly workspace_id: string;
  readonly query_condition: QueryConditionReceipt;
  readonly canonical_query_evidence: CanonicalQueryEvidenceV1;
  readonly canonical_query_compilation: CanonicalQueryCompilationV1;
  readonly snapshot_vector: SnapshotVectorV1;
  readonly snapshot_coherence_receipt: SnapshotCoherenceReceiptV1;
  readonly snapshot_read_lease: SnapshotReadLeaseV1;
  readonly expected_lexical_request_pins: readonly Readonly<LexicalRequestPin>[];
}>;

export type VerifiedLiveQueryProofPins = Readonly<{
  readonly query_id: string;
  readonly workspace_id: string;
  readonly snapshot_digest: string;
}>;

export function verifyLiveQueryProofAuthority(
  authority: LiveQueryProofAuthority
): VerifiedLiveQueryProofPins {
  const condition = authority.query_condition;
  const compilation = authority.canonical_query_compilation;
  const vector = authority.snapshot_vector;
  const receipt = authority.snapshot_coherence_receipt;
  const lease = authority.snapshot_read_lease;
  verifySnapshotVectorV1(vector);
  verifySnapshotCoherenceReceiptV1(receipt, vector);
  verifyCanonicalQueryCompilationV1(
    compilation, authority.canonical_query_evidence, receipt
  );
  if (condition.condition.workspace_id !== authority.workspace_id ||
      vector.principal !== condition.condition.principal ||
      !sameStrings(vector.authorized_scopes, condition.condition.authorized_scopes) ||
      vector.effective_as_of !== condition.condition.effective_as_of) {
    throw new Error("live query proof prepared workspace identity mismatch");
  }
  if (compilation.query_identity.condition_identity !== condition.identity ||
      compilation.query_identity.query_operator_id !== condition.query_operator_id ||
      compilation.query_identity.generation_id !== condition.generation_id ||
      compilation.query_identity.query_cache_key !== condition.query_cache_key) {
    throw new Error("live query proof canonical query identity mismatch");
  }
  if (compilation.snapshot_receipt_digest !== receipt.receipt_digest) {
    throw new Error("live query proof canonical snapshot receipt mismatch");
  }
  const expectedLease = finalizePreparedSnapshotReadLease(vector);
  if (digestRecallFieldIdentity(lease) !== digestRecallFieldIdentity(expectedLease)) {
    throw new Error("live query proof snapshot lease mismatch");
  }
  verifyExpectedPins(authority.expected_lexical_request_pins, authority.workspace_id);
  return Object.freeze({
    query_id: compilation.query_identity.condition_identity,
    workspace_id: condition.condition.workspace_id,
    snapshot_digest: vector.vector_digest
  });
}

export function admitLiveLexicalProofs(
  authority: LiveQueryProofAuthority,
  values: readonly Readonly<LexicalBoundProof>[]
): readonly Readonly<LexicalBoundProof>[] | undefined {
  const pins = verifyLiveQueryProofAuthority(authority);
  const expected = authority.expected_lexical_request_pins;
  if (expected.length === 0 || values.length !== expected.length) return undefined;
  const expectedByKey = new Map(expected.map((pin) => [pinKey(pin), pin]));
  const admitted: LexicalBoundProof[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const proof = freezeLexicalBoundProof(value);
    if (proof === undefined || proof.status !== "captured" ||
        typeof proof.identity.request_digest !== "string" ||
        typeof proof.identity.workspace_id !== "string" ||
        typeof proof.field_prefix !== "string" ||
        proof.candidate_key_domain !== "memory_object_id") return undefined;
    const key = pinKey({
      workspace_id: proof.identity.workspace_id,
      request_digest: proof.identity.request_digest,
      field_prefix: proof.field_prefix,
      candidate_key_domain: proof.candidate_key_domain
    });
    if (seen.has(key) || !expectedByKey.has(key)) return undefined;
    if (proof.identity.snapshot_digest !== pins.snapshot_digest) return undefined;
    verifyLexicalBoundProof(proof);
    seen.add(key);
    admitted.push(proof);
  }
  return seen.size === expectedByKey.size ? Object.freeze(admitted) : undefined;
}

function verifyExpectedPins(
  pins: readonly Readonly<LexicalRequestPin>[],
  workspaceId: string
): void {
  const keys = new Set<string>();
  for (const pin of pins) {
    if (pin.workspace_id !== workspaceId ||
        !/^sha256:[0-9a-f]{64}$/u.test(pin.request_digest) ||
        (pin.field_prefix !== "lexical_relaxed" &&
          pin.field_prefix !== "lexical_expanded") ||
        pin.candidate_key_domain !== "memory_object_id") {
      throw new Error("live query proof lexical request pin mismatch");
    }
    const key = pinKey(pin);
    if (keys.has(key)) throw new Error("live query proof duplicate lexical request pin");
    keys.add(key);
  }
}

function pinKey(pin: LexicalRequestPin): string {
  return [pin.workspace_id, pin.request_digest, pin.field_prefix,
    pin.candidate_key_domain].join("\u0000");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedRight = [...right].sort((a, b) => a.localeCompare(b));
  return left.length === right.length && [...left]
    .sort((a, b) => a.localeCompare(b))
    .every((value, index) => value === normalizedRight[index]);
}
