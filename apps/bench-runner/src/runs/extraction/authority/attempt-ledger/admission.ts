import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import type { BenchProviderUsage } from "../../../compile-seed/compile-seed-types.js";
import type { ExtractionTransportProvenance } from "../../transport-route.js";
import { boundedArtifactEntryExists } from "../../cache-audit/bounded-artifact-reader.js";
import { readAttemptLedgerRecord } from "./contract.js";
import { settledAttemptUsageDigest, transportResponseDigest } from "./outcome.js";
import type { CachedProviderResponseWitness } from
  "../../../compile-seed/cache/provider-response-witness.js";

/** Read-only admission of the original physical attempt; recovery alone may promote staged bytes. */
export function inspectSettledProviderAttempt(input: {
  readonly cacheRoot: string;
  readonly cacheKey: string;
  readonly model: string;
  readonly requestProfile: string;
  readonly rawJsonSha256: string;
  readonly transportProvenance: ExtractionTransportProvenance;
  readonly attemptOrdinal: number;
  readonly authorityLineageDigest: string;
  readonly usage?: BenchProviderUsage;
  readonly aggregateUsage?: BenchProviderUsage;
  readonly responses?: readonly CachedProviderResponseWitness[];
}): { readonly status: "admitted" | "pending" | "invalid"; readonly reason?: string } {
  const path = join(input.cacheRoot,
    `extraction-attempt-ledger.${input.authorityLineageDigest}.json`);
  if (!boundedArtifactEntryExists(path)) {
    return { status: "invalid", reason: "original provider attempt ledger is missing" };
  }
  try {
    const record = readAttemptLedgerRecord(path);
    if (record.lineage_digest !== input.authorityLineageDigest ||
        record.cache_identity.model !== input.model ||
        record.cache_identity.requestProfile !== input.requestProfile) {
      return { status: "invalid", reason: "original provider attempt authority changed" };
    }
    const attempt = record.settled_attempts?.find((row) =>
      row.cache_key === input.cacheKey && row.attempt_ordinal === input.attemptOrdinal);
    const unresolved = record.unresolved_attempts.some((row) => row.cache_key === input.cacheKey);
    if (record.transport_failures.some((row) => row.cache_key === input.cacheKey &&
        row.attempt_ordinal === input.attemptOrdinal)) {
      return { status: "invalid", reason: "provider attempt failed transport" };
    }
    const successful = record.successful_shards.find((row) => row.cacheKey === input.cacheKey);
    for (const response of input.responses ?? []) {
      const named = record.settled_attempts?.find((row) =>
        row.cache_key === input.cacheKey && row.attempt_ordinal === response.attempt_ordinal);
      if (named?.usage_sha256 !== settledAttemptUsageDigest(response.usage) ||
          named.response_sha256 !== transportResponseDigest(response.witness) ||
          record.transport_failures.some((row) => row.cache_key === input.cacheKey &&
            row.attempt_ordinal === response.attempt_ordinal)) {
        return { status: "invalid", reason: "retained response differs from its settled physical attempt" };
      }
    }
    if (successful === undefined && record.pending_keys.includes(input.cacheKey) &&
        (attempt !== undefined || unresolved)) {
      return { status: "pending", reason: "provider attempt awaits ledger recovery" };
    }
    if (unresolved || attempt?.usage_sha256 !== settledAttemptUsageDigest(input.usage) ||
        input.responses !== undefined && attempt?.aggregate_usage_sha256 !==
          settledAttemptUsageDigest(input.aggregateUsage) ||
        input.responses !== undefined && input.responses.at(-1)?.attempt_ordinal !== input.attemptOrdinal ||
        successful?.successKind !== "provider" ||
        successful.attemptOrdinal !== input.attemptOrdinal ||
        successful.authorityLineageDigest !== input.authorityLineageDigest ||
        successful.rawJsonSha256 !== input.rawJsonSha256 ||
        !isDeepStrictEqual(successful.transportProvenance, input.transportProvenance)) {
      return { status: "invalid", reason: "provider response differs from settled attempt" };
    }
    return { status: "admitted" };
  } catch (cause) {
    return { status: "invalid", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
