import {
  isActiveRecallReadCapability,
  withActiveRecallReadSnapshot,
  type ActiveRecallReadCapability,
  type RecallReadSnapshotPort
} from "../../runtime/recall-read-snapshot.js";
import {
  readSnapshotLeaseCapability,
  type SnapshotReadLeaseCapabilityV1,
  type SnapshotReadLeaseV1
} from "../../runtime/snapshot-coherence/index.js";
import {
  createLexicalIntervalSourceReceiptIntegrityV1,
  verifyLexicalIntervalSourceReceiptIntegrityV1,
  type LexicalIntervalSourceReceiptV1
} from "./lexical-interval-source-receipt.js";
import type {
  RecallRetrievalFieldBundle,
  RecallRetrievalFieldBundleSource,
  RecordedFieldResult
} from "./retrieval-field-bundle.js";

declare const retrievalFieldSourceAuthorityBrand: unique symbol;

export type RetrievalFieldSourceAuthority = Readonly<{
  readonly [retrievalFieldSourceAuthorityBrand]: true;
}>;

type AuthorityState = {
  readonly source: RecallRetrievalFieldBundleSource;
  readonly records: RecordedFieldResult[];
  readonly authenticatedRecords: WeakMap<object, AuthenticatedRecordAuthority>;
  binding?: Readonly<{
    bundle: Readonly<RecallRetrievalFieldBundle>;
    lease: SnapshotReadLeaseV1;
    capability: ActiveRecallReadCapability;
  }>;
};

type AuthenticatedRecordAuthority = Readonly<{
  bundle: Readonly<RecallRetrievalFieldBundle>;
  capability: ActiveRecallReadCapability;
  sourceCapability: SnapshotReadLeaseCapabilityV1;
  snapshot_digest: NonNullable<SnapshotReadLeaseV1["vector_digest"]>;
}>;

const states = new WeakMap<object, AuthorityState>();
const bundleAuthorities = new WeakMap<object, RetrievalFieldSourceAuthority>();
const issuedReceipts = new WeakMap<object, Readonly<{
  capability: ActiveRecallReadCapability;
  snapshot_digest: NonNullable<SnapshotReadLeaseV1["vector_digest"]>;
}>>();

export function createRetrievalFieldSourceAuthority(
  source: RecallRetrievalFieldBundleSource,
  records: RecordedFieldResult[]
): RetrievalFieldSourceAuthority {
  const authority = Object.freeze({}) as RetrievalFieldSourceAuthority;
  states.set(authority, { source, records, authenticatedRecords: new WeakMap() });
  return authority;
}

export function registerRetrievalFieldBundleReadAuthority(
  bundle: Readonly<RecallRetrievalFieldBundle>,
  authority: RetrievalFieldSourceAuthority
): void {
  requireState(authority);
  bundleAuthorities.set(bundle, authority);
}

export function bindRetrievalFieldBundleReadAuthority(
  bundle: Readonly<RecallRetrievalFieldBundle>,
  lease: SnapshotReadLeaseV1,
  capability: ActiveRecallReadCapability | undefined
): void {
  const state = stateForBundle(bundle);
  if (!isActiveRecallReadCapability(capability)) {
    throw new TypeError("active physical recall read capability is required");
  }
  if (lease.state !== "finalized" || lease.vector_digest === null) {
    throw new TypeError("finalized snapshot read lease is required");
  }
  if (state.binding !== undefined) {
    throw new TypeError("retrieval field bundle read authority is already bound");
  }
  state.binding = Object.freeze({ bundle, lease, capability });
}

export async function withRetrievalFieldReadAuthority<T>(
  snapshot: RecallReadSnapshotPort | undefined,
  bundle: Readonly<RecallRetrievalFieldBundle>,
  lease: SnapshotReadLeaseV1,
  work: () => Promise<T>
): Promise<T> {
  return await withActiveRecallReadSnapshot(snapshot, async (capability) => {
    if (capability !== undefined) {
      bindRetrievalFieldBundleReadAuthority(bundle, lease, capability);
    }
    return await work();
  });
}

export function authenticateValidatedRetrievalFieldRecord(
  authority: RetrievalFieldSourceAuthority,
  record: RecordedFieldResult
): void {
  const state = requireState(authority);
  const binding = state.binding;
  if (binding === undefined || !isActiveRecallReadCapability(binding.capability) ||
      binding.lease.vector_digest === null || !state.records.includes(record) ||
      !isLexicalRecord(record)) return;
  const sourceCapability = readEligibleSourceCapability(binding.lease, record);
  if (sourceCapability === undefined) return;
  state.authenticatedRecords.set(record, Object.freeze({
    bundle: binding.bundle,
    capability: binding.capability,
    sourceCapability,
    snapshot_digest: binding.lease.vector_digest
  }));
}

export function readMemoryLexicalIntervalSources(
  bundle: Readonly<RecallRetrievalFieldBundle>
): readonly Readonly<LexicalIntervalSourceReceiptV1>[] {
  const authority = bundleAuthorities.get(bundle);
  if (authority === undefined) return Object.freeze([]);
  const state = requireState(authority);
  const binding = state.binding;
  if (binding === undefined || binding.bundle !== bundle ||
      !isActiveRecallReadCapability(binding.capability) ||
      binding.lease.vector_digest === null) return Object.freeze([]);
  const snapshotDigest = binding.lease.vector_digest;
  const receipts = state.records.flatMap((record) => {
    const provenance = state.authenticatedRecords.get(record);
    if (!isLexicalRecord(record) || provenance === undefined ||
        provenance.bundle !== bundle ||
        provenance.capability !== binding.capability ||
        provenance.snapshot_digest !== snapshotDigest ||
        !binding.lease.capabilities.includes(provenance.sourceCapability) ||
        !isActiveRecallReadCapability(provenance.capability)) return [];
    const receipt = createLexicalIntervalSourceReceiptIntegrityV1({
      workspace_id: state.source.workspaceId,
      request_digest: record.request_digest,
      snapshot_digest: snapshotDigest,
      field_prefix: record.prefix,
      requested_depth: record.requested_depth,
      result: record.result
    });
    issuedReceipts.set(receipt, Object.freeze({
      capability: provenance.capability,
      snapshot_digest: snapshotDigest
    }));
    return [receipt];
  });
  return Object.freeze(receipts);
}

export function verifyLexicalIntervalSourceReceiptV1(
  receipt: LexicalIntervalSourceReceiptV1
): void {
  verifyLexicalIntervalSourceReceiptIntegrityV1(receipt);
  const issuance = issuedReceipts.get(receipt);
  if (issuance === undefined) {
    throw new TypeError("lexical interval receipt lacks issued source authority");
  }
  if (!isActiveRecallReadCapability(issuance.capability)) {
    throw new TypeError("lexical interval receipt lacks active source authority");
  }
  if (receipt.snapshot_digest !== issuance.snapshot_digest) {
    throw new TypeError("lexical interval receipt source authority is inconsistent");
  }
}

function isLexicalRecord(
  record: RecordedFieldResult
): record is RecordedFieldResult & { readonly prefix: "lexical_relaxed" | "lexical_expanded" } {
  return record.source === "memory" && record.object_kind === "memory_entry" &&
    (record.prefix === "lexical_relaxed" || record.prefix === "lexical_expanded");
}

function readEligibleSourceCapability(
  lease: SnapshotReadLeaseV1,
  record: RecordedFieldResult
): SnapshotReadLeaseCapabilityV1 | undefined {
  let capability: SnapshotReadLeaseCapabilityV1;
  try {
    capability = readSnapshotLeaseCapability(lease, record.prefix);
  } catch {
    return undefined;
  }
  const declaration = capability.declaration;
  const eligibleView = capability.view_kind === "captured" ||
    capability.view_kind === "pinned";
  const eligibleLag = declaration.lag_bound.kind === "exact" ||
    declaration.lag_bound.kind === "bounded";
  if (capability.source_owner !== record.prefix ||
      declaration.source_owner !== record.prefix ||
      declaration.principal !== lease.principal ||
      !lease.authorized_scopes.includes(declaration.authorized_scope) ||
      !eligibleView || !eligibleLag ||
      declaration.source_frontier.trim().length === 0 ||
      declaration.generation.trim().length === 0) return undefined;
  return capability;
}

function stateForBundle(bundle: Readonly<RecallRetrievalFieldBundle>): AuthorityState {
  const authority = bundleAuthorities.get(bundle);
  if (authority === undefined) throw new TypeError("retrieval field bundle authority is missing");
  return requireState(authority);
}

function requireState(authority: RetrievalFieldSourceAuthority): AuthorityState {
  const state = states.get(authority);
  if (state === undefined) throw new TypeError("retrieval field source authority is invalid");
  return state;
}
