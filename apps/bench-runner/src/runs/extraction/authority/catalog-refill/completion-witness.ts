import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseExtractionCacheManifestContents, type ExtractionCacheManifestV3
} from "../../cache/extraction-cache-manifest.js";
import type { ExtractionAttemptLedgerSnapshot } from "../attempt-ledger.js";
import {
  assertExtractionAuthorityReceipt, type ExtractionAuthorityReceipt
} from "../receipt.js";
import { publishBytesExclusiveDurable } from
  "../../fill/manifest/durable-exclusive-publication.js";
import { serializeMaterializedTargetFillManifest } from
  "../../fill/manifest/fill-manifest.js";
import { readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";
import {
  parseSupplementalSourceReceipt,
  supplementalSourceManifestBinding,
  type SupplementalSourceReceipt
} from "../../cache/supplemental-source-receipt.js";
import {
  buildExtractionTransportProvenance,
  type ExtractionTransportProvenance
} from "../../transport-route.js";

const MAX_COMPLETION_WITNESS_BYTES = 32 * 1024 * 1024;
export const CATALOG_REFILL_COMPLETION_PREFIX = ".catalog-refill-completion.";

export interface CatalogRefillCompletionWitness {
  readonly schema_version: 1 | 2 | 3 | 4;
  readonly kind: "longmemeval-extraction-catalog-refill-completion";
  readonly completed_at: string;
  readonly authority_receipt: ExtractionAuthorityReceipt;
  readonly ledger_raw_sha256: string;
  readonly ledger_sha256: string;
  readonly successful_shards: readonly Readonly<{
    readonly cache_key: string;
    readonly raw_json_sha256: string;
    readonly success_kind?: "provider" | "deterministic" | "legacy-unclassified";
    readonly transport_provenance?: ExtractionTransportProvenance;
  }>[];
  readonly successor_manifest_sha256: string;
  readonly successor_manifest: ExtractionCacheManifestV3;
  readonly successor_content_closure_sha256: string;
  readonly supplemental_source_receipt?: SupplementalSourceReceipt;
  readonly witness_digest: string;
}

export function catalogRefillCompletionPath(
  cacheRoot: string,
  receiptDigest: string
): string {
  assertDigest(receiptDigest);
  return join(cacheRoot, `${CATALOG_REFILL_COMPLETION_PREFIX}${receiptDigest}.json`);
}

export function writeCatalogRefillCompletionWitness(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly ledger: ExtractionAttemptLedgerSnapshot;
  readonly manifest: ExtractionCacheManifestV3;
  readonly manifestSha256: string;
  readonly supplementalSourceReceipt?: SupplementalSourceReceipt;
}): CatalogRefillCompletionWitness {
  const witness = buildWitness(input);
  const path = catalogRefillCompletionPath(input.cacheRoot, input.receipt.receipt_digest);
  if (existsSync(path)) {
    const existing = readCatalogRefillCompletionWitness(path);
    if (!isDeepStrictEqual(existing, witness)) {
      throw new Error("catalog refill completion witness already differs");
    }
    return existing;
  }
  publishBytesExclusiveDurable({
    destination: path,
    bytes: Buffer.from(`${JSON.stringify(witness, null, 2)}\n`, "utf8"),
    ownerIdentity: input.receipt.receipt_digest,
    temporaryDirectory: dirname(input.cacheRoot)
  });
  return witness;
}

export function readCatalogRefillCompletionWitness(
  path: string
): CatalogRefillCompletionWitness {
  const value = JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: MAX_COMPLETION_WITNESS_BYTES, label: "catalog refill completion witness"
  })) as unknown;
  return parseCatalogRefillCompletionWitness(value);
}

export function hasValidCatalogRefillCompletionWitness(path: string): boolean {
  try {
    const witness = readCatalogRefillCompletionWitness(path);
    return witness.schema_version >= 3 && path === catalogRefillCompletionPath(
      dirname(path), witness.authority_receipt.receipt_digest
    );
  } catch {
    return false;
  }
}

function buildWitness(
  input: Parameters<typeof writeCatalogRefillCompletionWitness>[0]
): CatalogRefillCompletionWitness {
  assertCompletionInputs(input);
  const successfulShards = input.ledger.successfulEntries.map((entry) => ({
    cache_key: entry.cacheKey,
    raw_json_sha256: entry.rawJsonSha256,
    success_kind: entry.successKind,
    ...(entry.successKind !== "provider" ? {} : {
      transport_provenance: entry.transportProvenance
    })
  })).sort((left, right) => left.cache_key.localeCompare(right.cache_key));
  const unsigned = {
    schema_version: input.supplementalSourceReceipt === undefined ? 3 as const : 4 as const,
    kind: "longmemeval-extraction-catalog-refill-completion" as const,
    completed_at: input.manifest.built_at,
    authority_receipt: input.receipt,
    ledger_raw_sha256: input.ledger.rawLedgerSha256,
    ledger_sha256: input.ledger.ledgerSha256,
    successful_shards: Object.freeze(successfulShards),
    successor_manifest_sha256: input.manifestSha256,
    successor_manifest: Object.freeze(input.manifest),
    successor_content_closure_sha256: input.manifest.content_closure_sha256!,
    ...(input.supplementalSourceReceipt === undefined ? {} : {
      supplemental_source_receipt: input.supplementalSourceReceipt
    })
  };
  return Object.freeze({ ...unsigned, witness_digest: digest(JSON.stringify(unsigned)) });
}

function assertCompletionInputs(
  input: Parameters<typeof writeCatalogRefillCompletionWitness>[0]
): void {
  assertExtractionAuthorityReceipt(input.receipt, input.receipt.observation);
  const scope = input.receipt.catalog_refill;
  const successful = [...input.ledger.successfulKeys]
    .sort((left, right) => left.localeCompare(right));
  if (scope === undefined || input.ledger.lineageDigest !== input.receipt.lineage_digest ||
      input.ledger.pendingKeys.length !== 0 || input.ledger.unresolvedAttempts.length !== 0 ||
      !sameStrings(successful, scope.keys) || input.manifest.fill_status !== "complete" ||
      input.manifest.coverage !== 1 || input.manifest.content_closure_sha256 === undefined ||
      input.manifest.content_closure_index === undefined ||
      input.manifest.expected_key_set_sha256 !== scope.expected_key_set_sha256 ||
      input.manifest.expected_turns !==
        scope.preserved_valid_closure.shard_count + scope.shard_count ||
      input.manifest.cached_turns !== input.manifest.expected_turns ||
      !hasMatchingSupplementalBinding(input.manifest, input.supplementalSourceReceipt)) {
    throw new Error("catalog refill completion is not fully settled");
  }
  assertLedgerSuccessProvenance(input.receipt, input.ledger.successfulEntries);
  assertSupplementalReceiptMatchesAuthority(
    input.receipt, input.ledger.successfulEntries.map((entry) => ({
      cache_key: entry.cacheKey, raw_json_sha256: entry.rawJsonSha256
    })).sort((left, right) => left.cache_key.localeCompare(right.cache_key)),
    input.supplementalSourceReceipt
  );
}

function parseCatalogRefillCompletionWitness(
  value: unknown
): CatalogRefillCompletionWitness {
  if (!isRecord(value)) throw invalidWitness();
  const witness = value as unknown as CatalogRefillCompletionWitness;
  const fields = witness.schema_version === 2 || witness.schema_version === 4
    ? WITNESS_WITH_SUPPLEMENTAL_FIELDS
    : WITNESS_FIELDS;
  if (!hasExactFields(value, fields) ||
      ![1, 2, 3, 4].includes(witness.schema_version) ||
      witness.kind !== "longmemeval-extraction-catalog-refill-completion" ||
      !Number.isFinite(Date.parse(witness.completed_at)) ||
      !isDigest(witness.ledger_raw_sha256) || !isDigest(witness.ledger_sha256) ||
      !isDigest(witness.successor_manifest_sha256) ||
      !isDigest(witness.successor_content_closure_sha256) ||
      !isDigest(witness.witness_digest) || !Array.isArray(witness.successful_shards)) {
    throw invalidWitness();
  }
  assertExtractionAuthorityReceipt(witness.authority_receipt, witness.authority_receipt.observation);
  assertSuccessfulShards(witness.successful_shards, witness.schema_version);
  const supplemental = witness.schema_version === 2 || witness.schema_version === 4
    ? parseSupplementalSourceReceipt(
      witness.supplemental_source_receipt, "catalog refill completion witness"
    )
    : undefined;
  assertSupplementalReceiptMatchesAuthority(
    witness.authority_receipt, witness.successful_shards, supplemental
  );
  if (witness.schema_version >= 3) {
    assertWitnessSuccessProvenance(witness.authority_receipt, witness.successful_shards);
  }
  assertWitnessManifest(witness, supplemental);
  const { witness_digest: _digest, ...unsigned } = witness;
  if (digest(JSON.stringify(unsigned)) !== witness.witness_digest) throw invalidWitness();
  return Object.freeze(witness);
}

function assertWitnessManifest(
  witness: CatalogRefillCompletionWitness,
  supplemental: SupplementalSourceReceipt | undefined
): void {
  const scope = witness.authority_receipt.catalog_refill;
  const successfulKeys = witness.successful_shards.map((shard) => shard.cache_key);
  const manifest = parseExtractionCacheManifestContents(
    JSON.stringify(witness.successor_manifest), "catalog refill completion manifest"
  );
  if (scope === undefined || !sameStrings(successfulKeys, scope.keys) ||
      manifest.schema_version !== 3 || !isDeepStrictEqual(manifest, witness.successor_manifest) ||
      digestBytes(serializeMaterializedTargetFillManifest(manifest)) !==
        witness.successor_manifest_sha256 ||
      manifest.content_closure_sha256 !== witness.successor_content_closure_sha256 ||
      manifest.expected_key_set_sha256 !== scope.expected_key_set_sha256 ||
      manifest.expected_turns !== scope.preserved_valid_closure.shard_count + scope.shard_count ||
      manifest.cached_turns !== manifest.expected_turns || manifest.fill_status !== "complete" ||
      !hasMatchingSupplementalBinding(manifest, supplemental)) throw invalidWitness();
}

function assertSuccessfulShards(
  shards: CatalogRefillCompletionWitness["successful_shards"],
  schemaVersion: CatalogRefillCompletionWitness["schema_version"]
): void {
  const keys = shards.map((shard) => shard.cache_key);
  const sorted = [...new Set(keys)].sort((left, right) => left.localeCompare(right));
  if (!sameStrings(keys, sorted) || shards.some((shard) =>
    !isValidSuccessfulShard(shard, schemaVersion))) {
    throw invalidWitness();
  }
}

function isValidSuccessfulShard(
  shard: CatalogRefillCompletionWitness["successful_shards"][number],
  schemaVersion: CatalogRefillCompletionWitness["schema_version"]
): boolean {
  if (!isRecord(shard) || !isDigest(shard.cache_key) ||
      !isDigest(shard.raw_json_sha256)) return false;
  if (schemaVersion <= 2) return hasExactFields(shard, LEGACY_SHARD_FIELDS);
  if (shard.success_kind === "provider") {
    return hasExactFields(shard, PROVIDER_SHARD_FIELDS) &&
      isTransportProvenance(shard.transport_provenance);
  }
  return (shard.success_kind === "deterministic" ||
    shard.success_kind === "legacy-unclassified") &&
    hasExactFields(shard, TYPED_SHARD_FIELDS);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(value: unknown): asserts value is string {
  if (!isDigest(value)) throw invalidWitness();
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return sameStrings(Object.keys(value).sort(), [...fields].sort());
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasMatchingSupplementalBinding(
  manifest: ExtractionCacheManifestV3,
  receipt: SupplementalSourceReceipt | undefined
): boolean {
  const binding = receipt === undefined ? undefined : supplementalSourceManifestBinding(receipt);
  return isDeepStrictEqual(manifest.supplemental_source_receipt, binding);
}

function assertSupplementalReceiptMatchesAuthority(
  authority: ExtractionAuthorityReceipt,
  shards: readonly { readonly cache_key: string; readonly raw_json_sha256: string }[],
  supplemental: SupplementalSourceReceipt | undefined
): void {
  const transport = authority.observation.transport;
  const extraction = authority.observation.extraction;
  const alias = transport !== undefined &&
    (transport.providerUrl !== extraction.providerUrl || transport.model !== extraction.model);
  if (!alias) {
    if (supplemental !== undefined) throw invalidWitness();
    return;
  }
  const identities = shards.map((shard) => ({
    cache_key: shard.cache_key, raw_json_sha256: shard.raw_json_sha256
  }));
  if (supplemental === undefined || !isDeepStrictEqual(supplemental.shards, identities) ||
      supplemental.physical_source.provider_url !== transport.providerUrl ||
      supplemental.physical_source.model !== transport.model ||
      supplemental.logical_cache_identity.provider_url !== extraction.providerUrl ||
      supplemental.logical_cache_identity.model !== extraction.model ||
      supplemental.logical_cache_identity.request_profile !== extraction.requestProfile ||
      supplemental.logical_cache_identity.system_prompt_sha256 !== extraction.systemPromptSha256) {
    throw invalidWitness();
  }
}

function assertLedgerSuccessProvenance(
  authority: ExtractionAuthorityReceipt,
  shards: ExtractionAttemptLedgerSnapshot["successfulEntries"]
): void {
  const expected = expectedTransport(authority);
  if (shards.some((shard) => shard.successKind !== "provider" ||
      !isDeepStrictEqual(shard.transportProvenance, expected))) {
    throw new Error("catalog refill completion success provenance is invalid");
  }
}

function assertWitnessSuccessProvenance(
  authority: ExtractionAuthorityReceipt,
  shards: CatalogRefillCompletionWitness["successful_shards"]
): void {
  const expected = expectedTransport(authority);
  if (shards.some((shard) => shard.success_kind !== "provider" ||
      !isDeepStrictEqual(shard.transport_provenance, expected))) {
    throw invalidWitness();
  }
}

function expectedTransport(authority: ExtractionAuthorityReceipt): ExtractionTransportProvenance {
  const extraction = authority.observation.extraction;
  const transport = authority.observation.transport;
  return buildExtractionTransportProvenance({
    providerUrl: extraction.providerUrl,
    model: extraction.model,
    ...(transport === undefined ? {} : {
      transportProviderUrl: transport.providerUrl,
      transportModel: transport.model
    })
  });
}

function isPhysicalAlias(authority: ExtractionAuthorityReceipt): boolean {
  const extraction = authority.observation.extraction;
  const transport = authority.observation.transport;
  return transport !== undefined && (transport.providerUrl !== extraction.providerUrl ||
    transport.model !== extraction.model);
}

function isTransportProvenance(value: unknown): value is ExtractionTransportProvenance {
  if (!isRecord(value)) return false;
  return hasExactFields(value, ["provider_url_sha256", "model"]) &&
    typeof value.provider_url_sha256 === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.provider_url_sha256) &&
    typeof value.model === "string" && value.model.length > 0;
}

function invalidWitness(): Error {
  return new Error("catalog refill completion witness is invalid");
}

const WITNESS_FIELDS = [
  "schema_version", "kind", "completed_at", "authority_receipt",
  "ledger_raw_sha256", "ledger_sha256", "successful_shards",
  "successor_manifest_sha256", "successor_manifest",
  "successor_content_closure_sha256", "witness_digest"
] as const;

const WITNESS_WITH_SUPPLEMENTAL_FIELDS = [
  ...WITNESS_FIELDS, "supplemental_source_receipt"
] as const;

const LEGACY_SHARD_FIELDS = ["cache_key", "raw_json_sha256"] as const;
const TYPED_SHARD_FIELDS = ["cache_key", "raw_json_sha256", "success_kind"] as const;
const PROVIDER_SHARD_FIELDS = [...TYPED_SHARD_FIELDS, "transport_provenance"] as const;
