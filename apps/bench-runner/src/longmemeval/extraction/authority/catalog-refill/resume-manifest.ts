import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionAttemptLedgerSnapshot } from "../attempt-ledger.js";
import type { ExtractionAuthorityReceipt } from "../receipt.js";

const RESUME_MANIFEST_VERSION = 1;

interface CatalogRefillResumeManifest {
  readonly schema_version: typeof RESUME_MANIFEST_VERSION;
  readonly receipt_digest: string;
  readonly lineage_digest: string;
  readonly ledger_raw_sha256: string;
  readonly manifest_sha256: string;
}

export function readCatalogRefillResumeManifest(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly ledger: ExtractionAttemptLedgerSnapshot | undefined;
}): string | undefined {
  const path = resumeManifestPath(input.cacheRoot, input.receipt.receipt_digest);
  if (!existsSync(path)) return undefined;
  const record = readResumeManifest(path);
  if (input.ledger === undefined || record.receipt_digest !== input.receipt.receipt_digest ||
      record.lineage_digest !== input.receipt.lineage_digest ||
      record.ledger_raw_sha256 !== input.ledger.rawLedgerSha256) {
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
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function resumeManifestPath(cacheRoot: string, receiptDigest: string): string {
  assertDigest(receiptDigest);
  return join(cacheRoot, `.catalog-refill-resume.${receiptDigest}.json`);
}

function readResumeManifest(path: string): CatalogRefillResumeManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
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
