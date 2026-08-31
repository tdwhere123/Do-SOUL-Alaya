import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../../field/field-identity.js";
import {
  verifyLexicalIntervalSourceReceiptV1
} from
  "../../../../field/retrieval/retrieval-field-source-authority.js";
import type {
  LexicalIntervalSourceReceiptCapturedV1,
  LexicalIntervalSourceReceiptV1
} from
  "../../../../field/retrieval/lexical-interval-source-receipt.js";
import type { LiveQueryProofAuthority } from "../../live-query-proof-authority.js";
import type { ChannelClosureScope } from "../../closure/contract.js";
import { captureVerifiedLiveClosureAuthority } from
  "../../closure/live-authority-binding.js";

export type LiveLexicalClosureSource = Readonly<{
  readonly receipts: readonly Readonly<LexicalIntervalSourceReceiptCapturedV1>[];
  readonly scope: ChannelClosureScope;
  readonly source_receipt_digests: readonly RecallFieldDigest[];
  readonly source_lag_kind: "exact" | "bounded";
}>;

export function readLiveLexicalClosureSource(
  authority: LiveQueryProofAuthority
): LiveLexicalClosureSource | null {
  try {
    const captured = captureVerifiedLiveClosureAuthority(authority);
    const issued = captured.lexical_interval_sources;
    if (issued === undefined || !captured.source_identity_is_stable) return null;
    const admitted = admitCapturedLexicalSources(captured, issued);
    if (admitted === undefined || admitted.length !== 1 ||
        admitted[0]?.status !== "captured") return null;
    const receipts = Object.freeze([
      admitted[0] as Readonly<LexicalIntervalSourceReceiptCapturedV1>
    ]);
    const receipt = receipts[0]!;
    const capability = captured.authority.snapshot_read_lease.capabilities.find(
      ({ source_owner }) => source_owner === receipt.field_prefix
    );
    const lagKind = capability?.declaration.lag_bound.kind;
    if (capability?.source_owner !== receipt.field_prefix ||
        capability.declaration.source_owner !== receipt.field_prefix ||
        (lagKind !== "exact" && lagKind !== "bounded")) return null;
    const scope = Object.freeze({
      ...captured.binding,
      observer_id: receipt.producer_receipt.producer_id,
      channel_id: receipt.field_prefix,
      domain_id: `LexDomain:${receipt.field_prefix}`,
      universe_digest: lexicalUniverseDigest(receipts)
    });
    return Object.freeze({
      receipts,
      scope,
      source_lag_kind: lagKind,
      source_receipt_digests: Object.freeze(
        receipts.map(({ receipt_digest }) => receipt_digest).sort(compareText)
      )
    });
  } catch {
    return null;
  }
}

function admitCapturedLexicalSources(
  captured: ReturnType<typeof captureVerifiedLiveClosureAuthority>,
  values: readonly Readonly<LexicalIntervalSourceReceiptV1>[]
) {
  const expected = captured.authority.expected_lexical_request_pins;
  const bundle = captured.lexical_source_bundle;
  if (bundle === undefined || expected.length === 0 || values.length !== expected.length) {
    return undefined;
  }
  const expectedKeys = new Set(expected.map(sourceKey));
  const seen = new Set<string>();
  for (const value of values) {
    verifyLexicalIntervalSourceReceiptV1(value, {
      bundle,
      lease: captured.source_snapshot_read_lease
    });
    const key = sourceKey(value);
    if (seen.has(key) || !expectedKeys.has(key) ||
        value.snapshot_digest !== captured.binding.snapshot_digest) return undefined;
    seen.add(key);
  }
  return seen.size === expectedKeys.size ? Object.freeze([...values]) : undefined;
}

function sourceKey(value: Readonly<{
  readonly workspace_id: string;
  readonly request_digest: string;
  readonly field_prefix: string;
  readonly candidate_key_domain: string;
}>): string {
  return [value.workspace_id, value.request_digest, value.field_prefix,
    value.candidate_key_domain].join("\u0000");
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
