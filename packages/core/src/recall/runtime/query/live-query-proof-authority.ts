import {
  QueryConditionReceiptSchema,
  verifyQueryConditionReceipt,
  type QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import {
  verifyCanonicalQueryCompilationV1,
  type CanonicalQueryCompilationV1,
  type CanonicalQueryEvidenceV1
} from
  "../../query/canonical-query/index.js";
import type { LexicalRequestPin } from
  "../../field/retrieval/retrieval-field-bundle.js";
import type { LexicalIntervalSourceReceiptV1 } from
  "../../field/retrieval/lexical-interval-source-receipt.js";
import { verifyLexicalIntervalSourceReceiptV1 } from
  "../../field/retrieval/retrieval-field-source-authority.js";
import { digestRecallFieldIdentity } from "../../field/field-identity.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
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

export type LiveQueryProofAuthorityFailureCode =
  | "query_condition_invalid"
  | "workspace_identity_mismatch"
  | "canonical_query_invalid"
  | "canonical_query_identity_mismatch"
  | "canonical_snapshot_receipt_mismatch"
  | "snapshot_vector_invalid"
  | "snapshot_coherence_invalid"
  | "snapshot_lease_invalid"
  | "lexical_request_pin_invalid";

export class LiveQueryProofAuthorityError extends Error {
  public constructor(public readonly code: LiveQueryProofAuthorityFailureCode) {
    super("live query proof authority verification failed");
    this.name = "LiveQueryProofAuthorityError";
  }
}

export function liveQueryProofAuthorityFailureCode(
  error: unknown
): LiveQueryProofAuthorityFailureCode | null {
  return error instanceof LiveQueryProofAuthorityError ? error.code : null;
}

export function verifyLiveQueryProofAuthority(
  authority: LiveQueryProofAuthority
): VerifiedLiveQueryProofPins {
  const condition = authority.query_condition;
  const compilation = authority.canonical_query_compilation;
  const vector = authority.snapshot_vector;
  const receipt = authority.snapshot_coherence_receipt;
  const lease = authority.snapshot_read_lease;
  verifyStage("query_condition_invalid", () => {
    QueryConditionReceiptSchema.parse(condition);
    verifyQueryConditionReceipt(condition, fieldContractSha256);
  });
  verifyStage("snapshot_vector_invalid", () => verifySnapshotVectorV1(vector));
  verifyStage("snapshot_coherence_invalid", () =>
    verifySnapshotCoherenceReceiptV1(receipt, vector));
  if (condition.condition.workspace_id !== authority.workspace_id ||
      vector.principal !== condition.condition.principal ||
      !sameStrings(vector.authorized_scopes, condition.condition.authorized_scopes) ||
      vector.effective_as_of !== condition.condition.effective_as_of) {
    failAuthority("workspace_identity_mismatch");
  }
  if (compilation.snapshot_receipt_digest !== receipt.receipt_digest) {
    failAuthority("canonical_snapshot_receipt_mismatch");
  }
  verifyStage("canonical_query_invalid", () => verifyCanonicalQueryCompilationV1(
    compilation, authority.canonical_query_evidence, receipt
  ));
  if (compilation.query_identity.condition_identity !== condition.identity ||
      compilation.query_identity.query_operator_id !== condition.query_operator_id ||
      compilation.query_identity.generation_id !== condition.generation_id ||
      compilation.query_identity.query_cache_key !== condition.query_cache_key) {
    failAuthority("canonical_query_identity_mismatch");
  }
  verifyStage("snapshot_lease_invalid", () => {
    const expectedLease = finalizePreparedSnapshotReadLease(vector);
    if (digestRecallFieldIdentity(lease) !== digestRecallFieldIdentity(expectedLease)) {
      failAuthority("snapshot_lease_invalid");
    }
  });
  verifyExpectedPins(authority.expected_lexical_request_pins, authority.workspace_id);
  return Object.freeze({
    query_id: compilation.query_identity.condition_identity,
    workspace_id: condition.condition.workspace_id,
    snapshot_digest: vector.vector_digest
  });
}

export function admitLiveLexicalIntervalSources(
  authority: LiveQueryProofAuthority,
  values: readonly Readonly<LexicalIntervalSourceReceiptV1>[]
): readonly Readonly<LexicalIntervalSourceReceiptV1>[] | undefined {
  const pins = verifyLiveQueryProofAuthority(authority);
  const expected = authority.expected_lexical_request_pins;
  if (expected.length === 0 || values.length !== expected.length) return undefined;
  const expectedKeys = new Set(expected.map(pinKey));
  const seen = new Set<string>();
  for (const value of values) {
    try {
      verifyLexicalIntervalSourceReceiptV1(value);
    } catch {
      return undefined;
    }
    const key = pinKey(value);
    if (seen.has(key) || !expectedKeys.has(key) ||
        value.snapshot_digest !== pins.snapshot_digest) return undefined;
    seen.add(key);
  }
  return seen.size === expectedKeys.size ? Object.freeze([...values]) : undefined;
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
      failAuthority("lexical_request_pin_invalid");
    }
    const key = pinKey(pin);
    if (keys.has(key)) failAuthority("lexical_request_pin_invalid");
    keys.add(key);
  }
}

function verifyStage(
  code: LiveQueryProofAuthorityFailureCode,
  verify: () => void
): void {
  try {
    verify();
  } catch (error) {
    if (error instanceof LiveQueryProofAuthorityError) throw error;
    failAuthority(code);
  }
}

function failAuthority(code: LiveQueryProofAuthorityFailureCode): never {
  throw new LiveQueryProofAuthorityError(code);
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
