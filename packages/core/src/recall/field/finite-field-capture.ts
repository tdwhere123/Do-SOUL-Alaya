import {
  createRecallFiniteFieldSeal,
  type RecallFiniteFieldChannelInput,
  type RecallFiniteFieldSeal
} from "./finite-field-seal.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "./field-identity.js";

export const RECALL_FINITE_FIELD_CHANNEL_CAPTURE_OPERATOR_ID =
  "recall_finite_field_channel_capture_v1";

export const RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1 = Object.freeze([
  "lexical_relaxed_exact",
  "lexical_relaxed_porter",
  "lexical_relaxed_trigram",
  "lexical_expanded_exact",
  "lexical_expanded_porter",
  "lexical_expanded_trigram",
  "lexical_anchor_exact",
  "lexical_anchor_porter",
  "lexical_anchor_trigram",
  "synthesis_fts",
  "evidence_fts_exact",
  "evidence_fts_porter",
  "evidence_fts_trigram",
  "object_embedding_pool",
  "object_embedding_workspace",
  "evidence_semantic",
  "session_event_index",
  "explicit_pointer"
] as const);

export type RecallRetrievalFieldChannelId =
  typeof RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1[number];

type RetrievalFieldChannelInput = RecallFiniteFieldChannelInput & Readonly<{
  readonly channel_id: RecallRetrievalFieldChannelId;
}>;

export type RecallFiniteFieldChannelCapture = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof RECALL_FINITE_FIELD_CHANNEL_CAPTURE_OPERATOR_ID;
  readonly source_snapshot_digest: RecallFieldDigest;
  readonly channel: Readonly<RetrievalFieldChannelInput>;
  readonly capture_digest: RecallFieldDigest;
}>;

export function createRecallFiniteFieldChannelCapture(params: Readonly<{
  readonly source_snapshot_digest: RecallFieldDigest;
  readonly channel: Readonly<RetrievalFieldChannelInput>;
}>): RecallFiniteFieldChannelCapture {
  assertSha256(params.source_snapshot_digest, "finite field source snapshot digest");
  assertCatalogChannel(params.channel.channel_id);
  const channel = validateAndFreezeChannel(params);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: RECALL_FINITE_FIELD_CHANNEL_CAPTURE_OPERATOR_ID,
    source_snapshot_digest: params.source_snapshot_digest,
    channel
  });
  return Object.freeze({
    ...body,
    capture_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyRecallFiniteFieldChannelCapture(
  capture: RecallFiniteFieldChannelCapture
): void {
  if (capture.schema_version !== 1 ||
      capture.operator_id !== RECALL_FINITE_FIELD_CHANNEL_CAPTURE_OPERATOR_ID) {
    throw new Error("finite field channel capture operator mismatch");
  }
  const rebuilt = createRecallFiniteFieldChannelCapture({
    source_snapshot_digest: capture.source_snapshot_digest,
    channel: capture.channel
  });
  if (rebuilt.capture_digest !== capture.capture_digest) {
    throw new Error("finite field channel capture digest mismatch");
  }
}

export function materializeRecallRetrievalFieldCaptures(
  captures: readonly Readonly<RecallFiniteFieldChannelCapture>[]
): readonly Readonly<RecallFiniteFieldChannelCapture>[] {
  const capturesByChannel = indexCaptures(captures);
  return Object.freeze(RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1.map((channelId) =>
    capturesByChannel.get(channelId) ?? createRecallFiniteFieldChannelCapture({
      source_snapshot_digest: unavailableSourceDigest(channelId),
      channel: unavailableChannel(channelId)
    })
  ));
}

export function materializeRecallRetrievalFieldSeal(
  captures: readonly Readonly<RecallFiniteFieldChannelCapture>[]
): RecallFiniteFieldSeal {
  const materialized = materializeRecallRetrievalFieldCaptures(captures);
  const channels = materialized.map(({ channel }) => channel);
  const sourceSnapshots = materialized.map(({ channel, source_snapshot_digest }) =>
    Object.freeze({
      channel_id: channel.channel_id,
      source_snapshot_digest
    })
  );
  return createRecallFiniteFieldSeal({
    upstream_snapshot_digest: digestRecallFieldIdentity({
      channel_catalog: RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1,
      source_snapshots: sourceSnapshots
    }),
    channel_catalog: RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1,
    channels
  });
}

function validateAndFreezeChannel(params: Readonly<{
  readonly source_snapshot_digest: RecallFieldDigest;
  readonly channel: Readonly<RetrievalFieldChannelInput>;
}>): Readonly<RetrievalFieldChannelInput> {
  const validated = createRecallFiniteFieldSeal({
    upstream_snapshot_digest: params.source_snapshot_digest,
    channel_catalog: [params.channel.channel_id],
    channels: [params.channel]
  }).channels[0]!;
  return Object.freeze({
    channel_id: params.channel.channel_id,
    status: validated.status,
    depth: validated.depth,
    observations: validated.observations,
    unseen_upper_bound: validated.unseen_upper_bound
  });
}

function indexCaptures(
  captures: readonly Readonly<RecallFiniteFieldChannelCapture>[]
): ReadonlyMap<RecallRetrievalFieldChannelId, RecallFiniteFieldChannelCapture> {
  const indexed = new Map<
    RecallRetrievalFieldChannelId,
    RecallFiniteFieldChannelCapture
  >();
  for (const capture of captures) {
    verifyRecallFiniteFieldChannelCapture(capture);
    const channelId = capture.channel.channel_id;
    if (indexed.has(channelId)) {
      throw new Error("finite field capture channel owners must be unique");
    }
    indexed.set(channelId, capture);
  }
  return indexed;
}

function unavailableChannel(
  channelId: RecallRetrievalFieldChannelId
): RetrievalFieldChannelInput {
  return Object.freeze({
    channel_id: channelId,
    status: "unavailable",
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}

function unavailableSourceDigest(
  channelId: RecallRetrievalFieldChannelId
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    channel_id: channelId,
    status: "producer_receipt_unavailable"
  });
}

function assertCatalogChannel(channelId: string): asserts channelId is
  RecallRetrievalFieldChannelId {
  if (!RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1.includes(
    channelId as RecallRetrievalFieldChannelId
  )) {
    throw new Error("finite field capture channel is outside the retrieval catalog");
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}
