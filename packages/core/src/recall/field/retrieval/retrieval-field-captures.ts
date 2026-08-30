import type { FtsLaneId } from "@do-soul/alaya-protocol";
import type {
  KeywordSearchLaneReceipt
} from "../../runtime/recall-service-types.js";
import { buildRecallCandidateDedupeKey } from
  "../../runtime/recall-service-helpers.js";
import { compareText } from "../../../shared/compare-text.js";
import {
  createRecallFiniteFieldChannelCapture,
  type RecallFiniteFieldChannelCapture,
  type RecallRetrievalFieldChannelId
} from "../finite-field-capture.js";
import { digestRecallFieldIdentity } from "../field-identity.js";
import type {
  FieldPrefix,
  RecallRetrievalFieldBundleSource,
  RecordedFieldResult
} from "./retrieval-field-bundle.js";

const RAW_CHANNELS = Object.freeze([
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
  "evidence_fts_trigram"
] as const satisfies readonly RecallRetrievalFieldChannelId[]);

export function materializeRetrievalFieldBundleCaptures(
  bundle: RecallRetrievalFieldBundleSource,
  records: readonly RecordedFieldResult[]
): readonly Readonly<RecallFiniteFieldChannelCapture>[] {
  return Object.freeze(RAW_CHANNELS.map((channelId) =>
    channelId === "synthesis_fts"
      ? captureSynthesisChannel(bundle, records)
      : captureLaneChannel(bundle, records, channelId)
  ));
}

function captureLaneChannel(
  bundle: RecallRetrievalFieldBundleSource,
  records: readonly RecordedFieldResult[],
  channelId: Exclude<typeof RAW_CHANNELS[number], "synthesis_fts">
): RecallFiniteFieldChannelCapture {
  const { prefix, lane } = splitChannel(channelId);
  return captureReceipts(
    bundle,
    channelId,
    records.filter((record) => record.prefix === prefix).flatMap((record) => {
      const receipt = record.result.lanes.find((candidate) => candidate.lane === lane);
      return receipt === undefined ? [] : [{ record, receipt }];
    })
  );
}

function captureSynthesisChannel(
  bundle: RecallRetrievalFieldBundleSource,
  records: readonly RecordedFieldResult[]
): RecallFiniteFieldChannelCapture {
  return captureReceipts(
    bundle,
    "synthesis_fts",
    records.filter((record) => record.prefix === "synthesis_fts").flatMap((record) =>
      record.result.lanes.map((receipt) => ({ record, receipt }))
    )
  );
}

function captureReceipts(
  bundle: RecallRetrievalFieldBundleSource,
  channelId: typeof RAW_CHANNELS[number],
  entries: readonly Readonly<{
    readonly record: RecordedFieldResult;
    readonly receipt: Readonly<KeywordSearchLaneReceipt>;
  }>[]
): RecallFiniteFieldChannelCapture {
  const ordered = [...entries].sort((left, right) =>
    compareText(left.record.request_digest, right.record.request_digest) ||
    lanePriority(left.receipt.lane) - lanePriority(right.receipt.lane)
  );
  const status = resolveCaptureStatus(bundle, channelId, ordered.map(({ receipt }) => receipt));
  const observations = status === "unavailable" || status === "ineligible"
    ? []
    : ordered.flatMap(({ record, receipt }) => receipt.observations.map((observation) =>
      ({ record, receipt, observation })
    ));
  const channelObservations = Object.freeze(observations.map((entry, index) => Object.freeze({
    observation_id:
      `${channelId}:${entry.record.request_digest}:${entry.observation.source_id ?? entry.observation.object_id}:${entry.observation.rank}`,
    candidate_key: buildRecallCandidateDedupeKey({
      entry: { object_id: entry.observation.object_id },
      objectKind: entry.record.object_kind
    }),
    rank: index + 1
  })));
  return createRecallFiniteFieldChannelCapture({
    source_snapshot_digest: digestRecallFieldIdentity({
      producer: "request_scoped_retrieval_field_bundle_v1",
      workspace_id: bundle.workspaceId,
      channel_id: channelId,
      records: ordered.map(({ record, receipt }) => ({
        request_digest: record.request_digest,
        source: record.source,
        matches: record.result.matches,
        receipt
      })),
      status
    }),
    channel: Object.freeze({
      channel_id: channelId,
      status,
      depth: channelObservations.length,
      observations: channelObservations,
      unseen_upper_bound: status === "truncated"
        ? Math.max(...ordered.map(({ receipt }) => receipt.unseen_upper_bound ?? 0), 0)
        : status === "complete" ? 0 : null
    })
  });
}

function resolveCaptureStatus(
  bundle: RecallRetrievalFieldBundleSource,
  channelId: typeof RAW_CHANNELS[number],
  receipts: readonly Readonly<KeywordSearchLaneReceipt>[]
): KeywordSearchLaneReceipt["status"] {
  if (receipts.some((receipt) => receipt.status === "unavailable")) return "unavailable";
  if (receipts.some((receipt) => receipt.status === "truncated")) return "truncated";
  if (receipts.some((receipt) => receipt.status === "complete")) return "complete";
  if (receipts.length > 0 || bundle.queryText === null) return "ineligible";
  return sourceAvailable(bundle, channelId) ? "ineligible" : "unavailable";
}

function sourceAvailable(
  bundle: RecallRetrievalFieldBundleSource,
  channelId: typeof RAW_CHANNELS[number]
): boolean {
  if (channelId.startsWith("evidence_fts")) {
    return bundle.evidenceSearchPort?.searchByKeywordField !== undefined ||
      bundle.evidenceSearchPort?.searchManyByKeywordField !== undefined;
  }
  if (channelId === "synthesis_fts") {
    return bundle.synthesisSearchPort?.searchByKeywordField !== undefined ||
      bundle.synthesisSearchPort?.searchManyByKeywordField !== undefined;
  }
  return channelId.startsWith("lexical_anchor")
    ? bundle.memoryRepo.searchByAnchorField !== undefined
    : bundle.memoryRepo.searchByKeywordField !== undefined;
}

function splitChannel(
  channelId: Exclude<typeof RAW_CHANNELS[number], "synthesis_fts">
): Readonly<{ readonly prefix: Exclude<FieldPrefix, "synthesis_fts">; readonly lane: FtsLaneId }> {
  const lane = channelId.endsWith("_exact")
    ? "exact"
    : channelId.endsWith("_porter") ? "porter" : "trigram";
  const suffix = `_${lane}`;
  return Object.freeze({
    prefix: channelId.slice(0, -suffix.length) as Exclude<FieldPrefix, "synthesis_fts">,
    lane
  });
}

function lanePriority(lane: FtsLaneId): number {
  return lane === "exact" ? 0 : lane === "porter" ? 1 : 2;
}
