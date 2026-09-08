import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
import {
  PREPARE_RETRIEVAL_CHANNEL_OWNERS,
  capturePreparedSnapshotVector,
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  finalizePreparedSnapshotReadLease,
  type SnapshotCoherenceReceiptV1,
  type SnapshotReadLeaseV1,
  type SnapshotVectorV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../recall/runtime/query/field-query-session.js";
import type { RecallServiceMemoryRepoPort } from "../../../../recall/runtime/recall-service-types.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { conditionDraft } from "../../query/query-condition-test-fixtures.js";

const NOW = "2026-08-29T00:00:00.000Z";

export type LexicalSourceAuthorityFixture = Readonly<{
  readonly snapshotReadLease: SnapshotReadLeaseV1;
  readonly snapshotVector: SnapshotVectorV1;
}>;

type PinnedLexicalSourceAuthority = LexicalSourceAuthorityFixture & {
  readonly session: ReturnType<typeof createSeededTestOnlyInMemoryFieldQuerySession>;
  readonly pin: ReturnType<
    ReturnType<typeof createSeededTestOnlyInMemoryFieldQuerySession>["pinActiveGeneration"]
  >;
  readonly snapshotCoherenceReceipt: SnapshotCoherenceReceiptV1;
};

export function stubMemoryRepo(
  searchByKeywordField?: RecallServiceMemoryRepoPort["searchByKeywordField"]
): RecallServiceMemoryRepoPort {
  return {
    findByWorkspaceId: async () => [],
    findByDimension: async () => [],
    findByScopeClass: async () => [],
    ...(searchByKeywordField === undefined ? {} : { searchByKeywordField })
  };
}

export async function preparedAuthority(): Promise<LexicalSourceAuthorityFixture> {
  return freezeAuthority(unavailableSnapshot);
}

export async function capturedLexicalPreparedAuthority(): Promise<LexicalSourceAuthorityFixture> {
  return freezeAuthority(capturedLexicalSnapshot);
}

export function cleanup(prepared: LexicalSourceAuthorityFixture): void {
  const pinned = prepared as PinnedLexicalSourceAuthority;
  pinned.session.release(pinned.pin, NOW);
}

function freezeAuthority(
  vectorFor: (pin: PinnedLexicalSourceAuthority["pin"]) => SnapshotVectorV1
): PinnedLexicalSourceAuthority {
  const session = createSeededTestOnlyInMemoryFieldQuerySession(
    fieldContractSha256, "workspace-1"
  );
  const pin = session.pinActiveGeneration("workspace-1", NOW);
  const snapshotVector = vectorFor(pin);
  return Object.freeze({
    session,
    pin,
    snapshotVector,
    snapshotCoherenceReceipt: createSnapshotCoherenceReceiptV1(snapshotVector),
    snapshotReadLease: finalizePreparedSnapshotReadLease(snapshotVector)
  });
}

function unavailableSnapshot(
  pin: PinnedLexicalSourceAuthority["pin"]
): SnapshotVectorV1 {
  return capturePreparedSnapshotVector({
    queryCondition: pinnedCondition(pin),
    pin,
    retrieval_channel_owners: PREPARE_RETRIEVAL_CHANNEL_OWNERS
  });
}

function capturedLexicalSnapshot(
  pin: PinnedLexicalSourceAuthority["pin"]
): SnapshotVectorV1 {
  const prepared = unavailableSnapshot(pin);
  const { schema_version: _schemaVersion, vector_digest: _vectorDigest, ...input } = prepared;
  return createSnapshotVectorV1({
    ...input,
    retrieval_channel_snapshots: prepared.retrieval_channel_snapshots.map(
      (declaration) => declaration.source_owner === "lexical_relaxed"
        ? Object.freeze({
            ...declaration,
            source_frontier: "lexical-frontier:test-captured",
            generation: "lexical-generation:test-captured",
            lag_bound: Object.freeze({ kind: "exact" as const })
          })
        : declaration
    )
  });
}

function pinnedCondition(pin: PinnedLexicalSourceAuthority["pin"]) {
  return captureQueryCondition(conditionDraft({
    principal: "workspace-1",
    authorized_scopes: ["workspace-1"],
    workspace_project: "workspace-1"
  }), {
    sha256: fieldContractSha256,
    now: () => NOW,
    pin
  });
}
