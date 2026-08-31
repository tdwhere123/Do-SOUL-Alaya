import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
import {
  assertClosureStatusPayload,
  CHANNEL_CLOSURE_OPERATOR_ID,
  normalizeChannelRemainingEffect,
  type ChannelClosureResult,
  type ChannelClosureStatus,
  type ScopedCompletenessReference
} from "./contract.js";

export function verifyChannelClosureResult(result: ChannelClosureResult): void {
  const { result_digest: _digest, ...body } = result;
  if (result.schema_version !== 1 ||
      result.operator_id !== CHANNEL_CLOSURE_OPERATOR_ID ||
      result.result_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("channel closure result digest mismatch");
  }
  assertStatus(result.status);
  for (const [value, field] of [
    [result.scope_digest, "scope"],
    [result.query_digest, "query"],
    [result.snapshot_digest, "snapshot"],
    [result.principal_digest, "principal"],
    [result.universe_digest, "universe"]
  ] as const) assertDigest(value, `channel closure ${field}`);
  for (const [value, field] of [
    [result.observer_id, "observer"],
    [result.channel_id, "channel"],
    [result.domain_id, "domain"],
    [result.reason, "reason"]
  ] as const) assertIdentity(value, `channel closure ${field}`);

  const effects = result.remaining_effects.map(normalizeChannelRemainingEffect);
  assertUnique(effects.map(({ effect_id }) => effect_id),
    "channel closure remaining effect ids");
  const references = result.completeness_refs.map((reference) =>
    verifyCompletenessReference(reference, result));
  assertUnique(references.map(({ reference_digest }) => reference_digest),
    "channel closure completeness references");
  assertClosureStatusPayload(result.status, effects, references);
}

function verifyCompletenessReference(
  reference: ScopedCompletenessReference,
  result: ChannelClosureResult
): ScopedCompletenessReference {
  const { reference_digest: _digest, ...body } = reference;
  if (reference.receipt_id !== "query_proof_scoped_completeness_v1" ||
      reference.scope_digest !== result.scope_digest ||
      reference.domain_id !== result.domain_id ||
      reference.reference_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("channel closure completeness reference mismatch");
  }
  assertDigest(reference.source_receipt_digest,
    "channel closure completeness source");
  assertDigest(reference.universe_digest,
    "channel closure completeness universe");
  assertIdentity(reference.coordinate_id,
    "channel closure completeness coordinate");
  return reference;
}

function assertStatus(value: string): asserts value is ChannelClosureStatus {
  if (!STATUSES.has(value)) throw new Error("channel closure status is invalid");
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

function assertDigest(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}

const STATUSES: ReadonlySet<string> = new Set([
  "not_applicable",
  "exact_closed",
  "bounded_open",
  "uncertified"
]);
