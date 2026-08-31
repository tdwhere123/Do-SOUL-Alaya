import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
import { compareText } from "../../../../shared/compare-text.js";
import {
  assertClosureStatusPayload,
  CHANNEL_CLOSURE_OPERATOR_ID,
  digestClosureScope,
  normalizeClosureQuerySensitivities,
  normalizeChannelRemainingEffect,
  type ChannelClosureResult,
  type ChannelClosureStatus,
  type ScopedCompletenessReference
} from "./contract.js";
import {
  captureData,
  captureVerifiedLiveClosureAuthority,
  type LiveClosureAuthorityBinding
} from "./live-authority-binding.js";
import { closeLexicalBoundChannel } from "./lexical-bound.js";
import type { LiveQueryProofAuthority } from "../live-query-proof-authority.js";

export function verifyChannelClosureResult(
  result: ChannelClosureResult,
  authority: LiveQueryProofAuthority
): ChannelClosureResult {
  const capturedResult = captureData(result);
  const captured = captureVerifiedLiveClosureAuthority(authority);
  verifyClosureEnvelope(capturedResult);
  verifyLiveClosureBinding(capturedResult, captured.binding);
  verifyClosurePayload(capturedResult);
  if (capturedResult.source_kind !== "live_lexical_interval") {
    throw new Error("channel closure lacks an admitted live source");
  }
  const expected = closeLexicalBoundChannel(captured.source_authority);
  if (expected === null || expected.result_digest !== capturedResult.result_digest) {
    throw new Error("channel closure live source binding mismatch");
  }
  return capturedResult;
}

function verifyClosureEnvelope(result: ChannelClosureResult): void {
  assertExactKeys(result, [
    "schema_version", "operator_id", "status", "scope_digest", "authority_digest",
    "query_digest", "request_digest", "snapshot_digest", "principal_digest",
    "workspace_id", "observer_id", "channel_id",
    "domain_id", "universe_digest", "sensitivity_manifest", "remaining_effects",
    "completeness_refs", "source_kind", "source_receipt_digests", "reason",
    "result_digest"
  ], "channel closure result");
  const { result_digest: _digest, ...body } = result;
  if (result.schema_version !== 1 ||
      result.operator_id !== CHANNEL_CLOSURE_OPERATOR_ID ||
      result.result_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("channel closure result digest mismatch");
  }
  assertStatus(result.status);
  for (const [value, field] of [
    [result.scope_digest, "scope"],
    [result.authority_digest, "authority"],
    [result.query_digest, "query"],
    [result.request_digest, "request"],
    [result.snapshot_digest, "snapshot"],
    [result.principal_digest, "principal"],
    [result.universe_digest, "universe"]
  ] as const) assertDigest(value, `channel closure ${field}`);
  for (const [value, field] of [
    [result.workspace_id, "workspace"],
    [result.observer_id, "observer"],
    [result.channel_id, "channel"],
    [result.domain_id, "domain"],
    [result.reason, "reason"]
  ] as const) assertIdentity(value, `channel closure ${field}`);
}

function verifyLiveClosureBinding(
  result: ChannelClosureResult,
  live: LiveClosureAuthorityBinding
): void {
  const sensitivities = normalizeClosureQuerySensitivities(result.sensitivity_manifest);
  if (result.authority_digest !== live.authority_digest ||
      result.query_digest !== live.query_digest ||
      result.request_digest !== live.request_digest ||
      result.snapshot_digest !== live.snapshot_digest ||
      result.principal_digest !== live.principal_digest ||
      result.workspace_id !== live.workspace_id ||
      digestRecallFieldIdentity(sensitivities) !==
        digestRecallFieldIdentity(live.sensitivities) ||
      result.scope_digest !== digestClosureScope({
        authority_digest: result.authority_digest,
        query_digest: result.query_digest,
        request_digest: result.request_digest,
        snapshot_digest: result.snapshot_digest,
        principal_digest: result.principal_digest,
        workspace_id: result.workspace_id,
        observer_id: result.observer_id,
        channel_id: result.channel_id,
        domain_id: result.domain_id,
        universe_digest: result.universe_digest,
        sensitivities
      })) {
    throw new Error("channel closure live authority binding mismatch");
  }
}

function verifyClosurePayload(result: ChannelClosureResult): void {
  const sensitivities = normalizeClosureQuerySensitivities(result.sensitivity_manifest);
  const sensitivityById = new Map(sensitivities.map((row) => [row.sensitivity_id, row]));
  const effects = result.remaining_effects.map(normalizeChannelRemainingEffect);
  if (effects.some((effect) => sensitivityById.get(effect.sensitivity_id)?.effect !==
      effect.effect)) throw new Error("channel closure effect sensitivity mismatch");
  assertUnique(effects.map(({ effect_id }) => effect_id),
    "channel closure remaining effect ids");
  const references = result.completeness_refs.map((reference) =>
    verifyCompletenessReference(reference, result));
  assertUnique(references.map(({ reference_digest }) => reference_digest),
    "channel closure completeness references");
  assertClosureStatusPayload(result.status, effects, references);
  result.source_receipt_digests.forEach((digest) =>
    assertDigest(digest, "channel closure source receipt"));
  if (new Set(result.source_receipt_digests).size !==
      result.source_receipt_digests.length) {
    throw new Error("channel closure source receipts must be unique");
  }
}

function verifyCompletenessReference(
  reference: ScopedCompletenessReference,
  result: ChannelClosureResult
): ScopedCompletenessReference {
  const { reference_digest: _digest, ...body } = reference;
  assertExactKeys(reference, [
    "receipt_id", "source_receipt_digest", "scope_digest", "universe_digest",
    "domain_id", "coordinate_id", "reference_digest"
  ], "channel closure completeness reference");
  if (reference.receipt_id !== "query_proof_scoped_completeness_v1" ||
      reference.scope_digest !== result.scope_digest ||
      reference.universe_digest !== result.universe_digest ||
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

function assertExactKeys(value: object, allowed: readonly string[], field: string): void {
  const keys = Object.keys(value).sort(compareText);
  const expected = [...allowed].sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing fields`);
  }
}

const STATUSES: ReadonlySet<string> = new Set([
  "not_applicable",
  "exact_closed",
  "bounded_open",
  "uncertified"
]);
