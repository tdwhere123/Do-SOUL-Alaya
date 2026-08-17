import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtractionAuthorityInspection } from "../inspection.js";
import type { ExtractionAuthorityReceipt } from "../receipt.js";
import { receiptExtractionCacheIdentity } from "../receipt-cache-identity.js";
import {
  readExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot
} from "../attempt-ledger.js";
import {
  EXTRACTION_ATTEMPT_LEDGER_VERSION,
  emptyAttemptTelemetry,
  persistAttemptLedgerRecordExclusive,
  type ExtractionAttemptLedgerRecord
} from "../attempt-ledger/contract.js";
import { assertCatalogRefillScopeMatchesInspection } from "./scope.js";
import type { ExtractionCacheWriteLease } from "../../fill/manifest/fill-root-guard.js";

export function initializeCatalogRefillIssuanceLedger(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly inspection: ExtractionAuthorityInspection;
  readonly writeLease: ExtractionCacheWriteLease;
}): ExtractionAttemptLedgerSnapshot {
  const scope = input.receipt.catalog_refill;
  if (scope === undefined) throw new Error("catalog refill issuance requires catalog scope");
  input.writeLease.assertOwned();
  if (resolve(input.cacheRoot) !== input.writeLease.cacheRoot) {
    throw new Error("catalog refill issuance lease belongs to another cache root");
  }
  assertCatalogRefillScopeMatchesInspection({
    scope,
    cacheRoot: input.cacheRoot,
    inspection: input.inspection
  });
  const record = pristineLedgerRecord(input.receipt);
  const ledgerRoot = input.writeLease.stableRootPath;
  const path = catalogRefillIssuanceLedgerPath(ledgerRoot, input.receipt.lineage_digest);
  try {
    persistAttemptLedgerRecordExclusive(path, record, ledgerRoot);
  } catch (cause) {
    if (!isAlreadyExistsError(cause)) throw cause;
  }
  input.writeLease.assertOwned();
  const snapshot = readExtractionAttemptLedger({
    cacheRoot: ledgerRoot,
    lineageDigest: input.receipt.lineage_digest,
    cacheIdentity: receiptExtractionCacheIdentity(input.receipt)
  });
  assertExactPristineLedger(snapshot, input.receipt, record);
  return snapshot;
}

function catalogRefillIssuanceLedgerPath(
  cacheRoot: string,
  lineageDigest: string
): string {
  return join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
}

function pristineLedgerRecord(receipt: ExtractionAuthorityReceipt): ExtractionAttemptLedgerRecord {
  return {
    schema_version: EXTRACTION_ATTEMPT_LEDGER_VERSION,
    lineage_digest: receipt.lineage_digest,
    cache_identity: receiptExtractionCacheIdentity(receipt),
    starting_missing: receipt.limits.starting_missing,
    maximum_attempts: receipt.limits.maximum_attempts,
    successful_shard_ceiling: receipt.limits.successful_shard_ceiling,
    attempts: 0,
    successful_shards: [],
    pending_keys: [],
    unresolved_attempts: [],
    transport_failures: [],
    telemetry: emptyAttemptTelemetry()
  };
}

function assertExactPristineLedger(
  snapshot: ExtractionAttemptLedgerSnapshot | undefined,
  receipt: ExtractionAuthorityReceipt,
  expected: ExtractionAttemptLedgerRecord
): asserts snapshot is ExtractionAttemptLedgerSnapshot {
  const expectedRaw = createHash("sha256")
    .update(`${JSON.stringify(expected)}\n`, "utf8").digest("hex");
  if (snapshot === undefined || snapshot.rawLedgerSha256 !== expectedRaw ||
      snapshot.lineageDigest !== receipt.lineage_digest ||
      snapshot.startingMissing !== receipt.limits.starting_missing ||
      snapshot.maximumAttempts !== receipt.limits.maximum_attempts ||
      snapshot.successfulShardCeiling !== receipt.limits.successful_shard_ceiling ||
      snapshot.attempts !== 0 || snapshot.successfulShards !== 0 ||
      snapshot.pendingKeys.length !== 0 || snapshot.unresolvedAttempts.length !== 0 ||
      snapshot.transportFailures.length !== 0) {
    throw new Error("catalog refill issuance ledger is not exact and pristine");
  }
}

function isAlreadyExistsError(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}
