import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../field/field-identity.js";
import { captureData } from "../../capture-data.js";
export { captureData } from "../../capture-data.js";
import {
  verifyLiveQueryProofAuthority,
  type LiveQueryProofAuthority,
  type VerifiedLiveQueryProofPins
} from "../live-query-proof-authority.js";
import {
  captureMemoryLexicalIntervalSources,
  type CapturedMemoryLexicalIntervalSources
} from "../../../field/retrieval/retrieval-field-source-authority.js";
import {
  CLOSURE_SENSITIVITY_EFFECTS,
  normalizeClosureQuerySensitivities,
  type ChannelClosureScope,
  type ClosureSensitivityEffect
} from "./contract.js";

export type LiveClosureAuthorityBinding = Readonly<Pick<ChannelClosureScope,
  "authority_digest" | "query_digest" | "request_digest" | "snapshot_digest" |
  "principal_digest" | "workspace_id" | "sensitivities">>;

export type VerifiedLiveClosureAuthorityCapture = Readonly<{
  readonly authority: LiveQueryProofAuthority;
  readonly binding: LiveClosureAuthorityBinding;
  readonly source_snapshot_read_lease: LiveQueryProofAuthority["snapshot_read_lease"];
  readonly lexical_source_bundle: LiveQueryProofAuthority["lexical_source_bundle"];
  readonly lexical_interval_sources: CapturedMemoryLexicalIntervalSources["receipts"] | undefined;
  readonly source_authority: LiveQueryProofAuthority;
  readonly source_identity_is_stable: boolean;
}>;

const capturedLiveAuthorities = new WeakMap<object, VerifiedLiveClosureAuthorityCapture>();

export function deriveLiveClosureAuthorityBinding(
  authority: LiveQueryProofAuthority
): LiveClosureAuthorityBinding {
  return captureVerifiedLiveClosureAuthority(authority).binding;
}

export function captureVerifiedLiveClosureAuthority(
  authority: LiveQueryProofAuthority
): VerifiedLiveClosureAuthorityCapture {
  const reused = capturedLiveAuthorities.get(authority);
  if (reused !== undefined) return reused;
  assertAuthorityFields(authority);
  const sourceLease = authority.snapshot_read_lease;
  const sourceBundle = authority.lexical_source_bundle;
  if (!isDeeplyFrozenData(sourceLease)) {
    throw new Error("live source snapshot read lease must be deeply frozen");
  }
  const capturedSources = sourceBundle === undefined
    ? undefined
    : captureMemoryLexicalIntervalSources(sourceBundle);
  const captured = Object.freeze({
    workspace_id: captureData(authority.workspace_id),
    query_condition: captureData(authority.query_condition),
    canonical_query_evidence: captureData(authority.canonical_query_evidence),
    canonical_query_compilation: captureData(authority.canonical_query_compilation),
    snapshot_vector: captureData(authority.snapshot_vector),
    snapshot_coherence_receipt: captureData(authority.snapshot_coherence_receipt),
    snapshot_read_lease: captureData(sourceLease),
    expected_lexical_request_pins: captureData(authority.expected_lexical_request_pins),
    ...(sourceBundle === undefined ? {} : { lexical_source_bundle: sourceBundle })
  }) satisfies LiveQueryProofAuthority;
  const pins = verifyLiveQueryProofAuthority(captured);
  const sourceAuthority = Object.freeze({
    ...captured,
    snapshot_read_lease: sourceLease
  }) satisfies LiveQueryProofAuthority;
  const result = Object.freeze({
    authority: captured,
    binding: deriveCapturedBinding(captured, pins),
    source_snapshot_read_lease: sourceLease,
    lexical_source_bundle: sourceBundle,
    lexical_interval_sources: capturedSources?.receipts,
    source_authority: sourceAuthority,
    source_identity_is_stable: sourceBundle === undefined || capturedSources !== undefined
  });
  capturedLiveAuthorities.set(captured, result);
  capturedLiveAuthorities.set(sourceAuthority, result);
  return result;
}

function deriveCapturedBinding(
  authority: LiveQueryProofAuthority,
  pins: VerifiedLiveQueryProofPins
): LiveClosureAuthorityBinding {
  const compilation = authority.canonical_query_compilation;
  const principalDigest = digestRecallFieldIdentity({
    principal: authority.snapshot_vector.principal,
    authorized_scopes: authority.snapshot_vector.authorized_scopes
  });
  const sensitivities = normalizeClosureQuerySensitivities(
    compilation.sensitivities.map((row) => Object.freeze({
      sensitivity_id: `${row.effect}:${row.target}`,
      effect: closureEffect(row.effect),
      target: row.target
    }))
  );
  const binding = Object.freeze({
    query_digest: compilation.digest,
    request_digest: authority.query_condition.identity as RecallFieldDigest,
    snapshot_digest: pins.snapshot_digest as RecallFieldDigest,
    principal_digest: principalDigest,
    workspace_id: pins.workspace_id,
    sensitivities
  });
  return Object.freeze({
    ...binding,
    authority_digest: digestRecallFieldIdentity({
      operator_id: "verified_live_query_proof_authority_binding_v1",
      ...binding,
      snapshot_coherence_receipt_digest:
        authority.snapshot_coherence_receipt.receipt_digest,
      snapshot_read_lease_id: authority.snapshot_read_lease.lease_id
    })
  });
}

function isDeeplyFrozenData(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== Array.prototype) ||
      !Object.isFrozen(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (!("value" in descriptor) || !isDeeplyFrozenData(descriptor.value, seen)) return false;
  }
  return Object.getOwnPropertySymbols(value).length === 0;
}

function assertAuthorityFields(authority: LiveQueryProofAuthority): void {
  const required = [
    "workspace_id", "query_condition", "canonical_query_evidence",
    "canonical_query_compilation", "snapshot_vector", "snapshot_coherence_receipt",
    "snapshot_read_lease", "expected_lexical_request_pins"
  ];
  const allowed = new Set([...required, "lexical_source_bundle"]);
  const keys = Object.keys(authority);
  if (keys.some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.prototype.hasOwnProperty.call(authority, key))) {
    throw new Error("live authority has unknown or missing fields");
  }
}

function closureEffect(effect: string): ClosureSensitivityEffect {
  if (effect === "extremum_range") return "extremum_interval";
  if (CLOSURE_SENSITIVITY_EFFECTS.has(effect)) return effect as ClosureSensitivityEffect;
  throw new Error("canonical query sensitivity effect is unsupported");
}
