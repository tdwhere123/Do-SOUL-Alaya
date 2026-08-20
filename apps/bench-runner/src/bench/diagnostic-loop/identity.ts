import { createHash } from "node:crypto";
import type { DiagnosticLoopIdentity } from "./types.js";

const SHA256_HEX = /^[a-f0-9]{64}$/u;

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

export function diagnosticLoopIdentityDigest(identity: DiagnosticLoopIdentity): string {
  return sha256Utf8(JSON.stringify({
    datasetRevision: identity.datasetRevision,
    requestedKeys: identity.requestedKeys,
    providerRoute: identity.providerRoute,
    model: identity.model,
    requestProfile: identity.requestProfile,
    promptDigest: identity.promptDigest,
    schemaDigest: identity.schemaDigest,
    operatorDigest: identity.operatorDigest,
    cacheMode: identity.cacheMode,
    variant: identity.variant,
    limit: identity.limit ?? null,
    offset: identity.offset ?? null,
    worker: identity.worker
  }));
}

export function assertDiagnosticLoopIdentity(identity: DiagnosticLoopIdentity): void {
  assertSha("datasetRevision", identity.datasetRevision);
  assertSha("promptDigest", identity.promptDigest);
  assertSha("schemaDigest", identity.schemaDigest);
  assertSha("operatorDigest", identity.operatorDigest);
  if (identity.requestedKeys.length === 0) {
    throw new Error("requestedKeys must contain at least one cache key");
  }
  const seen = new Set<string>();
  for (const key of identity.requestedKeys) {
    if (!isSha256Hex(key)) {
      throw new Error(`requested key is not a sha256 hex digest: ${key}`);
    }
    if (seen.has(key)) throw new Error(`duplicate requested key: ${key}`);
    seen.add(key);
  }
  assertPresent("providerRoute", identity.providerRoute);
  assertPresent("model", identity.model);
  assertPresent("requestProfile", identity.requestProfile);
  if (identity.cacheMode !== "cache_only") {
    throw new Error("diagnostic-loop identity cacheMode must be cache_only");
  }
}

function assertSha(field: string, value: string): void {
  if (!isSha256Hex(value)) {
    throw new Error(`${field} must be a sha256 hex digest`);
  }
}

function assertPresent(field: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
}
