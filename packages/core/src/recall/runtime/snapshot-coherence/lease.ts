import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { isSnapshotInstant } from "./digest.js";
import { derivedSources } from "./sources.js";
import { createSourceFrontierDeclaration } from "./source-frontier.js";
import type { SnapshotVectorV1, SourceFrontierDeclarationV1 } from "./types.js";

export const SNAPSHOT_READ_LEASE_OPERATOR_ID = "recall_snapshot_read_lease_v1" as const;

export const SNAPSHOT_READ_LEASE_STATES = ["open", "finalized", "released"] as const;

export type SnapshotReadLeaseState = (typeof SNAPSHOT_READ_LEASE_STATES)[number];

export const SNAPSHOT_READ_LEASE_VIEW_KINDS = ["pinned", "captured", "unavailable"] as const;

export type SnapshotReadLeaseViewKind = (typeof SNAPSHOT_READ_LEASE_VIEW_KINDS)[number];

export const SNAPSHOT_READ_LEASE_REJECT_CODES = [
  "undeclared_capability",
  "bind_after_finalize",
  "read_after_release",
  "adapter_substitution",
  "lease_not_open",
  "read_not_finalized",
  "mismatched_principal_scope",
  "source_owner_mismatch",
  "unbound_required_source",
  "invalid_view_kind",
  "lease_already_released"
] as const;

export type SnapshotReadLeaseRejectCode = (typeof SNAPSHOT_READ_LEASE_REJECT_CODES)[number];

export class SnapshotReadLeaseError extends Error {
  public readonly code: SnapshotReadLeaseRejectCode;

  public constructor(code: SnapshotReadLeaseRejectCode, message?: string) {
    super(message ?? code);
    this.name = "SnapshotReadLeaseError";
    this.code = code;
  }
}

export type SnapshotReadLeaseCapabilityV1 = Readonly<{
  readonly source_owner: string;
  readonly declaration: SourceFrontierDeclarationV1;
  readonly view_kind: SnapshotReadLeaseViewKind;
}>;

export type SnapshotReadLeaseV1 = Readonly<{
  readonly schema_version: 1;
  readonly lease_id: RecallFieldDigest;
  readonly state: SnapshotReadLeaseState;
  readonly principal: string;
  readonly authorized_scopes: readonly string[];
  readonly effective_as_of: string;
  readonly capabilities: readonly SnapshotReadLeaseCapabilityV1[];
  readonly vector_digest: RecallFieldDigest | null;
}>;

export type SnapshotReadLeaseOpenInput = Readonly<{
  readonly principal: string;
  readonly authorized_scopes: readonly string[];
  readonly effective_as_of: string;
}>;

export type SnapshotReadLeaseBindInput = Readonly<{
  readonly source_owner: string;
  readonly declaration: SourceFrontierDeclarationV1;
  readonly view_kind: SnapshotReadLeaseViewKind | string;
}>;

export function openSnapshotReadLease(
  input: SnapshotReadLeaseOpenInput
): SnapshotReadLeaseV1 {
  const principal = requireLeaseToken(input.principal, "mismatched_principal_scope");
  const authorized_scopes = freezeLeaseScopes(input.authorized_scopes);
  const effective_as_of = requireLeaseInstant(input.effective_as_of);
  return freezeLease({
    schema_version: 1,
    lease_id: digestLeaseId({ principal, authorized_scopes, effective_as_of }),
    state: "open",
    principal,
    authorized_scopes,
    effective_as_of,
    capabilities: Object.freeze([]),
    vector_digest: null
  });
}

export function bindSnapshotReadLease(
  lease: SnapshotReadLeaseV1,
  input: SnapshotReadLeaseBindInput
): SnapshotReadLeaseV1 {
  assertBindableState(lease);
  const capability = freezeCapability(lease, input);
  if (lease.capabilities.some((bound) => bound.source_owner === capability.source_owner)) {
    rejectLease("adapter_substitution");
  }
  const capabilities = Object.freeze(
    [...lease.capabilities, capability]
      .sort((left, right) => left.source_owner.localeCompare(right.source_owner))
  );
  return freezeLease({ ...lease, capabilities });
}

export function finalizeSnapshotReadLease(
  lease: SnapshotReadLeaseV1,
  vector: SnapshotVectorV1
): SnapshotReadLeaseV1 {
  if (lease.state !== "open") rejectLease("lease_not_open");
  assertLeaseMatchesVector(lease, vector);
  assertRequiredSourcesBound(lease, vector);
  return freezeLease({
    ...lease,
    state: "finalized",
    vector_digest: vector.vector_digest
  });
}

export function readSnapshotLeaseCapability(
  lease: SnapshotReadLeaseV1,
  sourceOwner: string
): SnapshotReadLeaseCapabilityV1 {
  if (lease.state === "released") rejectLease("read_after_release");
  if (lease.state !== "finalized") rejectLease("read_not_finalized");
  const capability = lease.capabilities.find((bound) => bound.source_owner === sourceOwner);
  if (capability === undefined) rejectLease("undeclared_capability");
  return capability;
}

export function releaseSnapshotReadLease(lease: SnapshotReadLeaseV1): SnapshotReadLeaseV1 {
  if (lease.state === "released") rejectLease("lease_already_released");
  return freezeLease({ ...lease, state: "released" });
}

function freezeCapability(
  lease: SnapshotReadLeaseV1,
  input: SnapshotReadLeaseBindInput
): SnapshotReadLeaseCapabilityV1 {
  const source_owner = requireLeaseToken(input.source_owner, "source_owner_mismatch");
  const declaration = createSourceFrontierDeclaration(input.declaration);
  if (declaration.source_owner !== source_owner) rejectLease("source_owner_mismatch");
  if (declaration.principal !== lease.principal
    || !lease.authorized_scopes.includes(declaration.authorized_scope)) {
    rejectLease("mismatched_principal_scope");
  }
  return Object.freeze({
    source_owner,
    declaration,
    view_kind: requireViewKind(input.view_kind)
  });
}

function assertBindableState(lease: SnapshotReadLeaseV1): void {
  if (lease.state === "finalized") rejectLease("bind_after_finalize");
  if (lease.state !== "open") rejectLease("lease_not_open");
}

function assertLeaseMatchesVector(
  lease: SnapshotReadLeaseV1,
  vector: SnapshotVectorV1
): void {
  if (lease.principal !== vector.principal
    || lease.effective_as_of !== vector.effective_as_of
    || digestRecallFieldIdentity(lease.authorized_scopes)
      !== digestRecallFieldIdentity(vector.authorized_scopes)) {
    rejectLease("mismatched_principal_scope");
  }
}

function assertRequiredSourcesBound(
  lease: SnapshotReadLeaseV1,
  vector: SnapshotVectorV1
): void {
  const bound = new Set(lease.capabilities.map((capability) => capability.source_owner));
  const missing = derivedSources(vector).some((source) => (
    (source.lag_bound.kind === "exact" || source.lag_bound.kind === "bounded")
    && !bound.has(source.source_owner)
  ));
  if (missing) rejectLease("unbound_required_source");
}

function freezeLease(lease: SnapshotReadLeaseV1): SnapshotReadLeaseV1 {
  return Object.freeze({
    schema_version: 1 as const,
    lease_id: lease.lease_id,
    state: lease.state,
    principal: lease.principal,
    authorized_scopes: lease.authorized_scopes,
    effective_as_of: lease.effective_as_of,
    capabilities: Object.freeze([...lease.capabilities]),
    vector_digest: lease.vector_digest
  });
}

function digestLeaseId(
  fields: Pick<SnapshotReadLeaseV1, "principal" | "authorized_scopes" | "effective_as_of">
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    operator_id: SNAPSHOT_READ_LEASE_OPERATOR_ID,
    principal: fields.principal,
    authorized_scopes: fields.authorized_scopes,
    effective_as_of: fields.effective_as_of
  });
}

function freezeLeaseScopes(scopes: readonly string[]): readonly string[] {
  if (scopes.length === 0) rejectLease("mismatched_principal_scope");
  const frozen = Object.freeze(
    [...scopes]
      .map((scope) => requireLeaseToken(scope, "mismatched_principal_scope"))
      .sort((left, right) => left.localeCompare(right))
  );
  if (new Set(frozen).size !== frozen.length) rejectLease("mismatched_principal_scope");
  return frozen;
}

function requireViewKind(value: string): SnapshotReadLeaseViewKind {
  if (value === "pinned" || value === "captured" || value === "unavailable") return value;
  rejectLease("invalid_view_kind");
}

function requireLeaseInstant(value: string): string {
  const token = requireLeaseToken(value, "mismatched_principal_scope");
  if (!isSnapshotInstant(token)) rejectLease("mismatched_principal_scope");
  return token;
}

function requireLeaseToken(value: string, code: SnapshotReadLeaseRejectCode): string {
  if (value.length === 0 || value.trim() !== value) rejectLease(code);
  return value;
}

function rejectLease(code: SnapshotReadLeaseRejectCode, message?: string): never {
  throw new SnapshotReadLeaseError(code, message ?? code);
}
