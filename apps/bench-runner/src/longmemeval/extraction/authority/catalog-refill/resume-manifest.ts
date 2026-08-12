import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtractionAttemptLedgerSnapshot } from "../attempt-ledger.js";
import type { ExtractionAuthorityReceipt } from "../receipt.js";
import {
  fsyncDirectory, replaceBytesDurable
} from "../../fill/manifest/durable-exclusive-publication.js";
import {
  boundedArtifactEntryExists, readBoundedCanonicalUtf8Artifact
} from
  "../../cache-audit/bounded-artifact-reader.js";

const RESUME_MANIFEST_VERSION = 1;
const MAX_RESUME_MANIFEST_BYTES = 64 * 1024;

export interface CatalogRefillResumeManifest {
  readonly schema_version: typeof RESUME_MANIFEST_VERSION;
  readonly receipt_digest: string;
  readonly lineage_digest: string;
  readonly ledger_raw_sha256: string;
  readonly manifest_sha256: string;
}

export function readCatalogRefillResumeManifestRecord(
  path: string
): CatalogRefillResumeManifest {
  return readResumeManifest(path);
}

export function readCatalogRefillResumeManifest(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly ledger: ExtractionAttemptLedgerSnapshot | undefined;
}): string | undefined {
  const path = resumeManifestPath(input.cacheRoot, input.receipt.receipt_digest);
  if (!boundedArtifactEntryExists(path)) return undefined;
  const record = readResumeManifest(path);
  if (input.ledger === undefined || record.receipt_digest !== input.receipt.receipt_digest ||
      record.lineage_digest !== input.receipt.lineage_digest) {
    throw new Error("catalog refill resume manifest does not match the active receipt ledger");
  }
  if (record.ledger_raw_sha256 !== input.ledger.rawLedgerSha256 &&
      !isSettledExact(input.receipt, input.ledger)) {
    throw new Error("catalog refill resume manifest does not match the active receipt ledger");
  }
  return record.manifest_sha256;
}

export function writeCatalogRefillResumeManifest(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly ledger: ExtractionAttemptLedgerSnapshot;
  readonly manifestSha256: string;
}): void {
  assertDigest(input.receipt.receipt_digest);
  assertDigest(input.receipt.lineage_digest);
  assertDigest(input.ledger.rawLedgerSha256);
  assertDigest(input.manifestSha256);
  const path = resumeManifestPath(input.cacheRoot, input.receipt.receipt_digest);
  const record: CatalogRefillResumeManifest = {
    schema_version: RESUME_MANIFEST_VERSION,
    receipt_digest: input.receipt.receipt_digest,
    lineage_digest: input.receipt.lineage_digest,
    ledger_raw_sha256: input.ledger.rawLedgerSha256,
    manifest_sha256: input.manifestSha256
  };
  mkdirSync(input.cacheRoot, { recursive: true });
  replaceBytesDurable({
    destination: path,
    bytes: Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
    ownerIdentity: input.receipt.receipt_digest,
    temporaryDirectory: dirname(input.cacheRoot)
  });
}

export function removeSettledCatalogRefillResumeManifest(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly ledger: ExtractionAttemptLedgerSnapshot;
}): void {
  const scope = input.receipt.catalog_refill;
  const successful = [...input.ledger.successfulKeys]
    .sort((left, right) => left.localeCompare(right));
  if (scope === undefined || input.ledger.lineageDigest !== input.receipt.lineage_digest ||
      input.ledger.pendingKeys.length !== 0 || input.ledger.unresolvedAttempts.length !== 0 ||
      !sameStrings(successful, scope.keys)) {
    throw new Error("catalog refill resume cleanup requires a settled matching ledger");
  }
  const path = resumeManifestPath(input.cacheRoot, input.receipt.receipt_digest);
  if (!boundedArtifactEntryExists(path)) return;
  const record = readResumeManifest(path);
  if (record.receipt_digest !== input.receipt.receipt_digest ||
      record.lineage_digest !== input.receipt.lineage_digest) {
    throw new Error("catalog refill resume cleanup found an unrelated record");
  }
  unlinkSync(path);
  fsyncDirectory(input.cacheRoot);
}

function resumeManifestPath(cacheRoot: string, receiptDigest: string): string {
  assertDigest(receiptDigest);
  return join(cacheRoot, `.catalog-refill-resume.${receiptDigest}.json`);
}

function readResumeManifest(path: string): CatalogRefillResumeManifest {
  let value: unknown;
  try {
    value = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path, maxBytes: MAX_RESUME_MANIFEST_BYTES, label: "catalog refill resume manifest"
    }));
  } catch (cause) {
    throw new Error(`catalog refill resume manifest is unreadable: ${path}`, { cause });
  }
  if (!isResumeManifest(value)) throw new Error("catalog refill resume manifest is invalid");
  return value;
}

function isResumeManifest(value: unknown): value is CatalogRefillResumeManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<CatalogRefillResumeManifest>;
  return record.schema_version === RESUME_MANIFEST_VERSION &&
    isDigest(record.receipt_digest) && isDigest(record.lineage_digest) &&
    isDigest(record.ledger_raw_sha256) && isDigest(record.manifest_sha256);
}

function assertDigest(value: unknown): asserts value is string {
  if (!isDigest(value)) throw new Error("catalog refill resume manifest digest is invalid");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSettledExact(
  receipt: ExtractionAuthorityReceipt,
  ledger: ExtractionAttemptLedgerSnapshot
): boolean {
  const scope = receipt.catalog_refill;
  if (scope === undefined || ledger.pendingKeys.length !== 0 ||
      ledger.unresolvedAttempts.length !== 0) return false;
  const successful = [...ledger.successfulKeys].sort((left, right) => left.localeCompare(right));
  return sameStrings(successful, scope.keys);
}
