import { isDeepStrictEqual } from "node:util";
import { cacheFilePath } from "../../../compile-seed/cache/cache-shard.js";
import type { ExtractionAttemptLedgerSnapshot } from "../../authority/attempt-ledger.js";
import type { ExtractionAuthorityReceipt } from "../../authority/receipt.js";
import { readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";
import type { ExtractionCacheManifestV3 } from "../../cache/extraction-cache-manifest.js";
import {
  createSupplementalSourceReceipt,
  supplementalSourceManifestBinding,
  type SupplementalSourceReceipt
} from "../../cache/supplemental-source-receipt.js";
import { buildExtractionTransportProvenance } from "../../transport-route.js";
import type { ExecutionExtractionAuthority } from "../fill-execution.js";

const MAX_REFILL_SHARD_BYTES = 128 * 1024;

export function assertCatalogRefillTransportReadiness(
  authority: ExecutionExtractionAuthority | undefined,
  cacheRoot: string,
  manifest: ExtractionCacheManifestV3 | undefined
): void {
  if (authority?.receipt.catalog_refill === undefined) return;
  assertCompleteTransportOverride();
  assertLogicalIdentity(authority.receipt, manifest);
  assertRefillTarget(manifest);
  const ledger = authority.snapshot();
  if (ledger === undefined) throw invalidTransport("attempt ledger is unavailable");
  if (isPhysicalAlias(authority.receipt)) {
    assertAliasTarget(manifest);
    assertSafePhysicalEndpoint(authority.receipt.observation.transport!.providerUrl);
    assertLedgerShardTransports(cacheRoot, authority.receipt, ledger);
  } else if (manifest?.supplemental_source_receipt !== undefined) {
    throw invalidTransport("direct transport cannot inherit a supplemental source binding");
  }
}

function assertCompleteTransportOverride(): void {
  const provider = process.env.ALAYA_BENCH_EXTRACTION_TRANSPORT_PROVIDER_URL?.trim();
  const model = process.env.ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL?.trim();
  if ((provider === undefined || provider === "") !== (model === undefined || model === "")) {
    throw invalidTransport("physical provider URL and model must be configured together");
  }
}

export function prepareCatalogRefillSupplementalReceipt(input: {
  readonly authority: ExecutionExtractionAuthority | undefined;
  readonly cacheRoot: string;
  readonly ledger: ExtractionAttemptLedgerSnapshot | undefined;
  readonly manifest: ExtractionCacheManifestV3;
  readonly createdAt: string;
}): SupplementalSourceReceipt | undefined {
  const authority = input.authority;
  if (authority?.receipt.catalog_refill === undefined || !isPhysicalAlias(authority.receipt)) {
    return undefined;
  }
  if (input.ledger === undefined) throw invalidTransport("attempt ledger is unavailable");
  assertSettledExact(authority.receipt, input.ledger);
  assertLogicalIdentity(authority.receipt, input.manifest);
  assertSafePhysicalEndpoint(authority.receipt.observation.transport!.providerUrl);
  assertLedgerShardTransports(input.cacheRoot, authority.receipt, input.ledger);
  const observation = authority.receipt.observation;
  const receipt = createSupplementalSourceReceipt({
    createdAt: input.createdAt,
    physicalProviderUrl: observation.transport!.providerUrl,
    physicalModel: observation.transport!.model,
    logicalProviderUrl: observation.extraction.providerUrl,
    logicalModel: observation.extraction.model,
    requestProfile: observation.extraction.requestProfile,
    systemPromptSha256: observation.extraction.systemPromptSha256,
    shards: input.ledger.successfulEntries.map((entry) => ({
      cache_key: entry.cacheKey, raw_json_sha256: entry.rawJsonSha256
    }))
  });
  const current = input.manifest.supplemental_source_receipt;
  if (current !== undefined && !isDeepStrictEqual(current, supplementalSourceManifestBinding(receipt))) {
    throw invalidTransport("complete manifest has a different supplemental source binding");
  }
  return receipt;
}

function assertLedgerShardTransports(
  cacheRoot: string,
  receipt: ExtractionAuthorityReceipt,
  ledger: ExtractionAttemptLedgerSnapshot
): void {
  const expected = buildExtractionTransportProvenance({
    model: receipt.observation.extraction.model,
    providerUrl: receipt.observation.extraction.providerUrl,
    transportModel: receipt.observation.transport!.model,
    transportProviderUrl: receipt.observation.transport!.providerUrl
  });
  for (const shard of ledger.successfulEntries) {
    const parsed = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: cacheFilePath(cacheRoot, shard.cacheKey),
      maxBytes: MAX_REFILL_SHARD_BYTES,
      label: `catalog refill shard ${shard.cacheKey}`
    })) as { readonly transport_provenance?: unknown };
    if (!isDeepStrictEqual(parsed.transport_provenance, expected)) {
      throw invalidTransport("successful shards have mixed or missing physical transport");
    }
  }
}

function assertLogicalIdentity(
  receipt: ExtractionAuthorityReceipt,
  manifest: ExtractionCacheManifestV3 | undefined
): void {
  const extraction = receipt.observation.extraction;
  if (manifest === undefined || manifest.extraction_model !== extraction.model ||
      manifest.request_profile !== extraction.requestProfile ||
      manifest.provider_url !== extraction.providerUrl ||
      manifest.system_prompt_sha256 !== extraction.systemPromptSha256) {
    throw invalidTransport("target manifest differs from the receipt logical identity");
  }
}

function assertRefillTarget(manifest: ExtractionCacheManifestV3 | undefined): void {
  if (manifest?.archive_url !== undefined || manifest?.archive_sha256 !== undefined ||
      manifest?.storage !== "git-tracked") {
    throw invalidTransport("catalog refill requires a git-tracked target without archive storage");
  }
}

function assertAliasTarget(manifest: ExtractionCacheManifestV3 | undefined): void {
  if (manifest?.supplemental_source_receipt !== undefined) {
    throw invalidTransport("physical alias refill requires an unbound git-tracked target");
  }
}

function assertSettledExact(
  receipt: ExtractionAuthorityReceipt,
  ledger: ExtractionAttemptLedgerSnapshot
): void {
  const scope = receipt.catalog_refill!;
  const successful = [...ledger.successfulKeys].sort((left, right) => left.localeCompare(right));
  if (ledger.pendingKeys.length !== 0 || ledger.unresolvedAttempts.length !== 0 ||
      !sameStrings(successful, scope.keys)) {
    throw invalidTransport("supplemental receipt requires an exact settled ledger");
  }
}

function isPhysicalAlias(receipt: ExtractionAuthorityReceipt): boolean {
  const transport = receipt.observation.transport;
  return transport !== undefined && (transport.providerUrl !== receipt.observation.extraction.providerUrl ||
    transport.model !== receipt.observation.extraction.model);
}

function assertSafePhysicalEndpoint(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidTransport("physical provider URL is invalid"); }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw invalidTransport("physical provider URL must not contain credentials, query, or fragment");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidTransport(detail: string): Error {
  return new Error(`catalog refill supplemental source rejected: ${detail}`);
}
