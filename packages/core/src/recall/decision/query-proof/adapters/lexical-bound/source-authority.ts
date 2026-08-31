import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../../field/field-identity.js";
import { readMemoryLexicalIntervalSources } from
  "../../../../field/retrieval/retrieval-field-source-authority.js";
import type { LexicalIntervalSourceReceiptCapturedV1 } from
  "../../../../field/retrieval/lexical-interval-source-receipt.js";
import {
  admitLiveLexicalIntervalSources,
  type LiveQueryProofAuthority
} from "../../live-query-proof-authority.js";
import type { ChannelClosureScope } from "../../closure/contract.js";
import { deriveLiveClosureAuthorityBinding } from
  "../../closure/live-authority-binding.js";

export type LiveLexicalClosureSource = Readonly<{
  readonly receipts: readonly Readonly<LexicalIntervalSourceReceiptCapturedV1>[];
  readonly scope: ChannelClosureScope;
  readonly source_receipt_digests: readonly RecallFieldDigest[];
}>;

export function readLiveLexicalClosureSource(
  authority: LiveQueryProofAuthority
): LiveLexicalClosureSource | null {
  try {
    const binding = deriveLiveClosureAuthorityBinding(authority);
    const bundle = authority.lexical_source_bundle;
    if (bundle === undefined) return null;
    const issued = readMemoryLexicalIntervalSources(bundle);
    const admitted = admitLiveLexicalIntervalSources(authority, issued);
    if (admitted === undefined || admitted.length !== 1 ||
        admitted[0]?.status !== "captured") return null;
    const receipts = Object.freeze([
      admitted[0] as Readonly<LexicalIntervalSourceReceiptCapturedV1>
    ]);
    const receipt = receipts[0]!;
    const scope = Object.freeze({
      ...binding,
      observer_id: receipt.producer_receipt.producer_id,
      channel_id: receipt.field_prefix,
      domain_id: `LexDomain:${receipt.field_prefix}`,
      universe_digest: lexicalUniverseDigest(receipts)
    });
    return Object.freeze({
      receipts,
      scope,
      source_receipt_digests: Object.freeze(
        receipts.map(({ receipt_digest }) => receipt_digest).sort(compareText)
      )
    });
  } catch {
    return null;
  }
}

function lexicalUniverseDigest(
  receipts: readonly Readonly<LexicalIntervalSourceReceiptCapturedV1>[]
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    operator_id: "live_lexical_interval_universe_v1",
    sources: receipts.map((receipt) => Object.freeze({
      receipt_digest: receipt.receipt_digest,
      candidate_key_domain: receipt.candidate_key_domain,
      requested_depth: receipt.requested_depth,
      lane_universes: receipt.producer_receipt.lanes.map((lane) => Object.freeze({
        lane_id: lane.lane_id,
        universe_digest: lane.evaluated_universe?.universe_digest ?? null
      })).sort((left, right) => compareText(left.lane_id, right.lane_id))
    }))
  });
}
