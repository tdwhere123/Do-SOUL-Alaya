import { createHash } from "node:crypto";
import type { CachedExtractionEntry } from "../../../../compile-seed/cache/cache-shard.js";
import {
  inspectCachedResponseMetadata,
  type CachedExtractionResponseMetadata
} from "../../../../compile-seed/cache/cached-response-metadata.js";
import { inspectExtractionRawJson } from "../../../content-closure.js";
import {
  readExtractionCacheManifestIdentity
} from "../../extraction-cache-manifest.js";
import {
  isExtractionTransportProvenance,
  type ExtractionTransportProvenance
} from "../../../transport-route.js";
import {
  inspectLoadedExtractionAuthorityEntry,
  type LoadedGlobalExtractionAuthority
} from "../../../../provenance/contract/extraction-authority-reference.js";
import { readRootBoundCanonicalUtf8Artifact } from
  "../../../cache-audit/bounded-artifact-reader.js";

export interface VerifiedLegacyExtractionEntry {
  readonly cacheKey: string;
  readonly fileSha256: string;
  readonly rawJsonSha256: string;
  readonly completionWitnessSha256: string;
  readonly responseMetadataSha256: string;
  readonly transportProvenanceSha256: string;
  readonly sourceAuthoritySha256: string;
  readonly sourceManifestSha256: string;
  readonly model: string;
  readonly modelFamily: string;
  readonly transportModel: string;
  readonly requestProfile: string;
  readonly providerUrlSha256: string;
  readonly systemPromptSha256: string;
}

interface SealedLegacyShardCapture {
  readonly root: string;
  readonly serialized: string;
  readonly completionMetadata: CachedExtractionResponseMetadata;
  readonly transport: ExtractionTransportProvenance;
}

interface SealedLegacyCompletionPin {
  readonly fileSha256: string;
  readonly responseMetadataSha256: string;
  readonly transportProvenanceSha256: string;
}

const captures = new WeakMap<object, SealedLegacyShardCapture>();
const snapshotCompletionPins = new WeakMap<object, Readonly<Record<string, SealedLegacyCompletionPin>>>();

export function readVerifiedLegacyExtractionEntry(input: {
  readonly root: string;
  readonly cacheKey: string;
  readonly authority: LoadedGlobalExtractionAuthority;
}): VerifiedLegacyExtractionEntry {
  if (!/^[a-f0-9]{64}$/u.test(input.cacheKey)) {
    throw new Error("legacy conversion cache identity is invalid");
  }
  const authority = inspectLoadedExtractionAuthorityEntry(
    input.authority, input.cacheKey
  );
  const manifestIdentity = readExtractionCacheManifestIdentity(input.root);
  if (manifestIdentity === undefined ||
      manifestIdentity.manifestSha256 !== authority.sourceManifestSha256) {
    throw new Error("legacy cache manifest is not bound by snapshot extraction authority");
  }
  const serialized = readRootBoundCanonicalUtf8Artifact({
    root: input.root,
    directorySegments: [input.cacheKey.slice(0, 2)],
    filename: `${input.cacheKey}.json`,
    maxBytes: 32 * 1024 * 1024,
    label: `legacy extraction shard ${input.cacheKey}`
  });
  const entry = parseEntry(serialized, input.cacheKey);
  const raw = inspectExtractionRawJson(entry.raw_json);
  if (raw.rawJsonSha256 !== authority.rawJsonSha256 ||
      raw.rawSignalCount !== authority.rawSignalCount ||
      raw.parsedDraftCount !== authority.parsedDraftCount) {
    throw new Error("legacy shard raw content is not bound by snapshot extraction authority");
  }
  const manifest = manifestIdentity.manifest;
  if (entry.model !== authority.extractionModel ||
      entry.request_profile !== authority.requestProfile ||
      manifest.extraction_model !== authority.extractionModel ||
      manifest.model_family !== authority.modelFamily ||
      manifest.request_profile !== authority.requestProfile ||
      manifest.system_prompt_sha256 !== authority.systemPromptSha256) {
    throw new Error("legacy shard execution identity is not bound by snapshot extraction authority");
  }
  const sealed = sealLegacyShardCompletionAuthority(entry, manifest.provider_url, authority.extractionModel);
  const fileSha256 = digest(serialized);
  sealSnapshotCompletionPin(input.authority, input.cacheKey, {
    fileSha256,
    responseMetadataSha256: sealed.responseMetadataSha256,
    transportProvenanceSha256: sealed.transportProvenanceSha256
  });
  const completionWitnessSha256 = digest(JSON.stringify({
    source_authority_sha256: authority.authoritySha256,
    source_manifest_sha256: authority.sourceManifestSha256,
    sealed_entry_sha256: fileSha256,
    cache_key: input.cacheKey,
    raw_json_sha256: authority.rawJsonSha256,
    raw_signal_count: authority.rawSignalCount,
    parsed_draft_count: authority.parsedDraftCount,
    response_metadata_sha256: sealed.responseMetadataSha256,
    transport_provenance_sha256: sealed.transportProvenanceSha256,
    extraction_model: authority.extractionModel,
    model_family: authority.modelFamily,
    transport_model: sealed.transport.model,
    request_profile: authority.requestProfile,
    fill_status: authority.fillStatus,
    coverage: authority.coverage
  }));
  const handle = Object.freeze({
    cacheKey: input.cacheKey,
    fileSha256,
    rawJsonSha256: authority.rawJsonSha256,
    completionWitnessSha256,
    responseMetadataSha256: sealed.responseMetadataSha256,
    transportProvenanceSha256: sealed.transportProvenanceSha256,
    sourceAuthoritySha256: authority.authoritySha256,
    sourceManifestSha256: authority.sourceManifestSha256,
    model: authority.extractionModel,
    modelFamily: authority.modelFamily,
    transportModel: sealed.transport.model,
    requestProfile: authority.requestProfile,
    providerUrlSha256: stripDigestPrefix(sealed.transport.provider_url_sha256),
    systemPromptSha256: authority.systemPromptSha256
  });
  captures.set(handle, Object.freeze({
    root: input.root,
    serialized,
    completionMetadata: sealed.responseMetadata,
    transport: sealed.transport
  }));
  return handle;
}

export function parseCapturedLegacyExtractionEntry(
  handle: VerifiedLegacyExtractionEntry
): CachedExtractionEntry {
  const capture = captures.get(handle);
  if (capture === undefined) {
    throw new Error("legacy conversion requires an authority-bound reader handle");
  }
  const current = readRootBoundCanonicalUtf8Artifact({
    root: capture.root,
    directorySegments: [handle.cacheKey.slice(0, 2)],
    filename: `${handle.cacheKey}.json`,
    maxBytes: 32 * 1024 * 1024,
    label: `legacy extraction shard ${handle.cacheKey}`
  });
  if (digest(current) !== handle.fileSha256 || current !== capture.serialized) {
    throw new Error("legacy shard changed after bounded capture");
  }
  const entry = parseEntry(capture.serialized, handle.cacheKey);
  const completion = inspectCanonicalCompletionMetadata(entry.response_metadata);
  const transport = inspectCanonicalTransportProvenance(entry.transport_provenance);
  if (digest(JSON.stringify(completion)) !== handle.responseMetadataSha256 ||
      digest(JSON.stringify(transport)) !== handle.transportProvenanceSha256) {
    throw new Error("legacy shard completion metadata changed after bounded capture");
  }
  return Object.freeze({
    model: entry.model,
    request_profile: entry.request_profile,
    cache_key: entry.cache_key,
    raw_json: entry.raw_json,
    extracted_at: entry.extracted_at,
    response_metadata: capture.completionMetadata,
    transport_provenance: capture.transport
  });
}

function parseEntry(serialized: string, cacheKey: string): CachedExtractionEntry {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new Error("legacy shard entry is invalid", { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("legacy shard entry is invalid");
  }
  const entry = value as Partial<CachedExtractionEntry>;
  if (entry.cache_key !== cacheKey || typeof entry.raw_json !== "string" ||
      typeof entry.model !== "string" || entry.model.length === 0 ||
      typeof entry.request_profile !== "string" || entry.request_profile.length === 0 ||
      typeof entry.extracted_at !== "string" || entry.extracted_at.length === 0) {
    throw new Error("legacy shard entry is invalid");
  }
  return entry as CachedExtractionEntry;
}

function sealLegacyShardCompletionAuthority(
  entry: CachedExtractionEntry,
  providerUrl: string,
  extractionModel: string
): Readonly<{
  readonly responseMetadata: CachedExtractionResponseMetadata;
  readonly transport: ExtractionTransportProvenance;
  readonly responseMetadataSha256: string;
  readonly transportProvenanceSha256: string;
}> {
  const responseMetadata = inspectCanonicalCompletionMetadata(entry.response_metadata);
  const transport = inspectCanonicalTransportProvenance(entry.transport_provenance);
  if (transport.provider_url_sha256 !== `sha256:${digest(providerUrl)}` ||
      transport.model !== extractionModel) {
    throw new Error("legacy shard transport provider/model mismatch");
  }
  return Object.freeze({
    responseMetadata,
    transport,
    responseMetadataSha256: digest(JSON.stringify(responseMetadata)),
    transportProvenanceSha256: digest(JSON.stringify(transport))
  });
}

function sealSnapshotCompletionPin(
  authority: LoadedGlobalExtractionAuthority,
  cacheKey: string,
  pin: SealedLegacyCompletionPin
): void {
  const existing = snapshotCompletionPins.get(authority)?.[cacheKey];
  if (existing !== undefined && (
    existing.fileSha256 !== pin.fileSha256 ||
    existing.responseMetadataSha256 !== pin.responseMetadataSha256 ||
    existing.transportProvenanceSha256 !== pin.transportProvenanceSha256
  )) {
    throw new Error("legacy shard completion metadata changed after snapshot seal");
  }
  snapshotCompletionPins.set(authority, Object.freeze({
    ...snapshotCompletionPins.get(authority),
    [cacheKey]: Object.freeze(pin)
  }));
}

function inspectCanonicalCompletionMetadata(
  value: CachedExtractionResponseMetadata | undefined
): CachedExtractionResponseMetadata {
  if (value === undefined ||
      !hasOwnFields(value, ["finish_reason", "completion_contract_version", "completion_witness"]) ||
      !hasExactOptionalFields(value, [
        "finish_reason",
        "max_output_tokens",
        "completion_contract_version",
        "completion_witness",
        "usage"
      ])) {
    throw new Error("legacy shard response_metadata is missing or non-canonical");
  }
  if (value.usage !== undefined && (!hasExactOptionalFields(value.usage, [
    "input_tokens", "output_tokens", "total_tokens"
  ]) || value.usage.total_tokens !== value.usage.input_tokens + value.usage.output_tokens)) {
    throw new Error("legacy shard response_metadata usage is non-canonical");
  }
  inspectCachedResponseMetadata(value, true);
  if (value.completion_contract_version !== 1 ||
      value.completion_witness === undefined ||
      (value.finish_reason !== "stop" && value.finish_reason !== null)) {
    throw new Error(`legacy shard response_metadata is not complete: finish_reason=${value.finish_reason}`);
  }
  return Object.freeze({
    finish_reason: value.finish_reason,
    ...(value.max_output_tokens === undefined ? {} : {
      max_output_tokens: value.max_output_tokens
    }),
    completion_contract_version: value.completion_contract_version,
    completion_witness: value.completion_witness,
    ...(value.usage === undefined ? {} : { usage: Object.freeze({
      input_tokens: value.usage.input_tokens,
      output_tokens: value.usage.output_tokens,
      total_tokens: value.usage.total_tokens
    }) })
  });
}

function inspectCanonicalTransportProvenance(
  value: ExtractionTransportProvenance | undefined
): ExtractionTransportProvenance {
  if (!isExtractionTransportProvenance(value) ||
      !hasExactOptionalFields(value, ["provider_url_sha256", "model"])) {
    throw new Error("legacy shard transport provenance is missing or invalid");
  }
  return Object.freeze({
    provider_url_sha256: value.provider_url_sha256,
    model: value.model
  });
}

function hasOwnFields(value: object, required: readonly string[]): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasExactOptionalFields(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function stripDigestPrefix(value: string): string {
  const stripped = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[a-f0-9]{64}$/u.test(stripped)) {
    throw new Error("legacy shard transport provider digest is invalid");
  }
  return stripped;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
