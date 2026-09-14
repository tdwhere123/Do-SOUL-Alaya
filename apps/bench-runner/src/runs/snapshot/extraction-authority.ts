import {
  MAX_LONGMEMEVAL_EXTRACTION_AUTHORITY_BYTES,
  LongMemEvalExtractionAuthoritySchema,
  assertLongMemEvalFullExtractionClosure,
  assertLongMemEvalExtractionAuthorityBinding,
  assertLongMemEvalExtractionAuthorityIntegrity,
  hashLongMemEvalExpansionArtifact,
  hashLongMemEvalSupplementalSourceBinding,
  parseLongMemEvalExtractionAuthority,
  type LongMemEvalExtractionAuthority
} from "@do-soul/alaya-eval/authority";
import {
  extractionCacheManifestPath,
  parseExtractionCacheManifestContents,
  type ProfiledExtractionCacheManifest
} from "../extraction/cache/extraction-cache-manifest.js";
import { hasCompleteExtractionFillAuthority } from
  "../extraction/fill/fill-authority.js";
import type { ProfiledSnapshotExtractionProvenance } from "./materialize.js";
import { redactProvenanceUrl } from "../provenance/paired-environment.js";
import { readRegularFileNoFollow, sha256Buffer } from "./bound-file.js";
import { redactSupplementalSourceBinding } from
  "../extraction/cache/supplemental-source-receipt.js";

export const MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES =
  MAX_LONGMEMEVAL_EXTRACTION_AUTHORITY_BYTES;
export type SnapshotExtractionAuthority = LongMemEvalExtractionAuthority;

export interface CapturedSnapshotExtractionAuthority {
  readonly compact: ProfiledSnapshotExtractionProvenance;
  readonly authority: SnapshotExtractionAuthority;
  readonly bytes: Buffer;
}

export function captureSnapshotExtractionAuthority(
  cacheRoot: string
): CapturedSnapshotExtractionAuthority {
  const filePath = extractionCacheManifestPath(cacheRoot);
  const sourceBytes = readRegularFileNoFollow(
    filePath,
    MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES
  );
  assertAuthoritySize(sourceBytes, filePath);
  const sourceSha256 = sha256Buffer(sourceBytes);
  const manifest = parseCompleteSourceManifest(sourceBytes, filePath);
  const compact = buildSnapshotExtractionSummary(manifest, sourceSha256);
  const authority = buildSnapshotExtractionAuthority(manifest, sourceSha256, compact);
  const bytes = renderSnapshotExtractionAuthority(authority);
  assertAuthoritySize(bytes, filePath);
  return { compact, authority, bytes };
}

export function buildSnapshotExtractionSummary(
  manifest: ProfiledExtractionCacheManifest,
  sourceManifestSha256: string
): ProfiledSnapshotExtractionProvenance {
  const expansion = sanitizedExpansionArtifacts(manifest);
  return {
    manifest_sha256: sourceManifestSha256,
    ...(manifest.schema_version === 4
      ? { schema_version: 4 as const, source_packing: manifest.source_packing }
      : { schema_version: 3 as const }),
    extraction_model: manifest.extraction_model,
    model_family: manifest.model_family,
    request_profile: manifest.request_profile,
    provider_url: redactProvenanceUrl(manifest.provider_url),
    system_prompt_sha256: manifest.system_prompt_sha256,
    cache_key_algo: manifest.cache_key_algo,
    dataset: manifest.dataset,
    dataset_revision: manifest.dataset_revision,
    requested_turns: manifest.requested_turns,
    cached_turns: manifest.cached_turns,
    coverage: manifest.coverage,
    fill_status: manifest.fill_status,
    window_offset: manifest.window_offset,
    window_limit: manifest.window_limit,
    expected_turns: manifest.expected_turns,
    expected_key_set_sha256: manifest.expected_key_set_sha256,
    content_closure_sha256: manifest.content_closure_sha256,
    ...(manifest.supplemental_source_receipt === undefined ? {} : {
      supplemental_source_receipt: redactSupplementalSourceBinding(
        manifest.supplemental_source_receipt,
        redactProvenanceUrl
      )
    }),
    ...expansion
  };
}

export function buildSnapshotExtractionAuthority(
  manifest: ProfiledExtractionCacheManifest,
  sourceManifestSha256: string,
  compact = buildSnapshotExtractionSummary(manifest, sourceManifestSha256)
): SnapshotExtractionAuthority {
  if (!hasCompleteExtractionFillAuthority(manifest)) {
    throw new Error("snapshot extraction authority requires a complete source manifest");
  }
  assertLongMemEvalFullExtractionClosure({
    ...compact,
    content_closure_index: manifest.content_closure_index
  });
  const candidate = {
    schema_version: 1,
    source_manifest_schema_version: manifest.schema_version,
    source_manifest_sha256: sourceManifestSha256,
    extraction_model: manifest.extraction_model,
    model_family: manifest.model_family,
    request_profile: manifest.request_profile,
    ...(manifest.schema_version === 4 ? { source_packing: manifest.source_packing } : {}),
    system_prompt_sha256: manifest.system_prompt_sha256,
    cache_key_algo: manifest.cache_key_algo,
    dataset: manifest.dataset,
    dataset_revision: manifest.dataset_revision,
    requested_turns: manifest.requested_turns,
    cached_turns: manifest.cached_turns,
    coverage: manifest.coverage,
    fill_status: manifest.fill_status,
    window_offset: manifest.window_offset,
    window_limit: manifest.window_limit,
    expected_turns: manifest.expected_turns,
    expected_key_set_sha256: manifest.expected_key_set_sha256,
    content_closure_sha256: manifest.content_closure_sha256,
    content_closure_index: manifest.content_closure_index,
    ...(compact.supplemental_source_receipt === undefined ? {} : {
      supplemental_source_binding_sha256: hashLongMemEvalSupplementalSourceBinding(
        compact.supplemental_source_receipt
      )
    }),
    ...expansionDigests(compact)
  };
  return parseAuthority(candidate, "captured extraction authority");
}

export function renderSnapshotExtractionAuthority(
  authority: SnapshotExtractionAuthority
): Buffer {
  return Buffer.from(`${JSON.stringify(authority)}\n`, "utf8");
}

export function parseSnapshotExtractionAuthorityBytes(
  bytes: Uint8Array,
  label: string
): SnapshotExtractionAuthority {
  assertAuthoritySize(bytes, label);
  try {
    const authority = parseLongMemEvalExtractionAuthority(bytes, label);
    return assertLongMemEvalExtractionAuthorityIntegrity(authority);
  } catch (cause) {
    throw new Error(`snapshot extraction authority is invalid at ${label}`, { cause });
  }
}

export function assertSnapshotExtractionAuthorityBinding(
  authority: SnapshotExtractionAuthority,
  compact: ProfiledSnapshotExtractionProvenance
): void {
  assertLongMemEvalExtractionAuthorityBinding({ authority, compact });
}

function parseCompleteSourceManifest(
  bytes: Uint8Array,
  filePath: string
): ProfiledExtractionCacheManifest {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`extraction manifest is not strict UTF-8 at ${filePath}`, { cause });
  }
  const manifest = parseExtractionCacheManifestContents(raw, filePath);
  if ((manifest.schema_version !== 3 && manifest.schema_version !== 4) ||
      !hasCompleteExtractionFillAuthority(manifest)) {
    throw new Error("snapshot extraction authority requires a complete v3 or v4 manifest");
  }
  return manifest;
}

function parseAuthority(value: unknown, label: string): SnapshotExtractionAuthority {
  const parsed = LongMemEvalExtractionAuthoritySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`snapshot extraction authority is incomplete or invalid at ${label}`);
  }
  try {
    return assertLongMemEvalExtractionAuthorityIntegrity(parsed.data);
  } catch (cause) {
    throw new Error(`snapshot extraction authority is incomplete or invalid at ${label}`, {
      cause
    });
  }
}

function sanitizedExpansionArtifacts(manifest: ProfiledExtractionCacheManifest) {
  return {
    ...(manifest.expansion_source_anchor === undefined ? {} : {
      expansion_source_anchor: sanitizeSnapshotProvenanceValue(manifest.expansion_source_anchor)
    }),
    ...(manifest.expansion_lineage === undefined ? {} : {
      expansion_lineage: sanitizeSnapshotProvenanceValue(manifest.expansion_lineage)
    })
  };
}

export function sanitizeSnapshotProvenanceValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, nested: unknown) =>
    key.endsWith("provider_url") && typeof nested === "string"
      ? redactProvenanceUrl(nested)
      : nested)) as T;
}

function expansionDigests(compact: ProfiledSnapshotExtractionProvenance) {
  return {
    ...(compact.expansion_source_anchor === undefined ? {} : {
      expansion_source_anchor_sha256: hashLongMemEvalExpansionArtifact(
        compact.expansion_source_anchor
      )
    }),
    ...(compact.expansion_lineage === undefined ? {} : {
      expansion_lineage_sha256: hashLongMemEvalExpansionArtifact(
        compact.expansion_lineage
      )
    })
  };
}

function assertAuthoritySize(value: { readonly byteLength: number }, label: string): void {
  if (value.byteLength <= MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES) return;
  throw new Error(`snapshot extraction authority exceeds its size budget at ${label}`);
}
