import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  inspectCachedExtraction
} from "../../compile-seed/cache/cache-shard.js";
import {
  readExtractionCacheManifestIdentity,
  type ExtractionCacheManifestV3
} from "../../extraction/cache/extraction-cache-manifest.js";
import { hasCompleteExtractionFillAuthority } from
  "../../extraction/fill/fill-authority.js";
import type { ExtractionContentClosureIndex } from
  "../../extraction/content-closure.js";
import { bindQuerySemanticFactorCacheFileToRequest } from
  "../../query-factors/query-semantic-factor-cache.js";
import type { DiagnosticQueryFactorCacheIdentity } from
  "../../query-factors/query-semantic-factor-cache-identity.js";
import {
  snapshotExtractionAuthorityPath,
  snapshotManifestPath,
  readSnapshotManifest,
  readSnapshotSidecar,
  snapshotQuestionIdDigest,
  assertSnapshotConsumerBinding
} from "../../snapshot/materialize.js";
import {
  buildSnapshotArtifactIntegrity,
  sha256File,
  verifySnapshotArtifactIntegrity
} from "../../snapshot/integrity.js";
import {
  MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES,
  assertSnapshotExtractionAuthorityBinding,
  parseSnapshotExtractionAuthorityBytes
} from "../../snapshot/extraction-authority.js";
import { readRegularFileNoFollow } from "../../snapshot/bound-file.js";
import { bindSnapshotRunProvenanceAuthority } from "../../snapshot/run-provenance.js";
import {
  assertDiagnosticManifestConsumeAuthority,
  assertDiagnosticSnapshotConsumeAuthority
} from "../../snapshot/current/diagnostic-consume-authority.js";
import { diagnosticLoopIdentityDigest, sha256Utf8 } from "../identity.js";
import type {
  DiagnosticLoopIdentity,
  DiagnosticLoopRequest
} from "../types.js";
import { CACHED_F3_EXPOSURE_POLICY } from
  "../../diagnostics/stage-attribution/exposure/contract.js";

export interface DiagnosticExtractionCacheIdentity {
  readonly root: string;
  readonly manifest_sha256: string;
  readonly dataset_revision: string;
  readonly extraction_model: string;
  readonly request_profile: string;
  readonly system_prompt_sha256: string;
  readonly content_closure_sha256: string;
  readonly expected_key_set_sha256: string;
  readonly shard_count: number;
  readonly window_offset: number;
  readonly window_limit: number;
}

export type DiagnosticExtractionAuthorityBinding = Omit<
  DiagnosticExtractionCacheIdentity,
  "root"
>;

export interface DiagnosticSnapshotIdentity {
  readonly path: string;
  readonly db_sha256: string;
  readonly manifest_sha256: string;
  readonly sidecar_sha256: string;
  readonly extraction_authority_sha256: string;
  readonly question_count: number;
  readonly question_ids: readonly string[];
  readonly question_id_digest: string;
  readonly dataset_sha256: string;
  readonly extraction_binding: DiagnosticExtractionAuthorityBinding;
  readonly identity_digest: string;
}

export interface ResolvedDiagnosticLoopIdentity {
  readonly schema_version: 3;
  readonly canonical_mode: "cache_only";
  readonly request_identity_digest: string;
  readonly request: DiagnosticLoopIdentity;
  readonly extraction_cache?: DiagnosticExtractionCacheIdentity;
  readonly snapshot?: DiagnosticSnapshotIdentity;
  readonly query_factor_cache?: DiagnosticQueryFactorCacheIdentity;
  readonly treatment_exposure_policy: typeof CACHED_F3_EXPOSURE_POLICY;
}

type CompleteExtractionManifest = ExtractionCacheManifestV3 & Readonly<{
  fill_status: "complete";
  expected_turns: number;
  expected_key_set_sha256: string;
  content_closure_sha256: string;
  content_closure_index: ExtractionContentClosureIndex;
  window_offset: number;
  window_limit: number;
}>;

export async function resolveDiagnosticLoopIdentity(
  request: DiagnosticLoopRequest
): Promise<ResolvedDiagnosticLoopIdentity> {
  const extraction = request.extractionCacheRoot === undefined
    ? undefined
    : resolveExtractionCacheIdentity(request);
  const snapshot = request.snapshotPath === undefined
    ? undefined
    : await resolveSnapshotIdentity(request.snapshotPath, request.variant);
  const query = request.treatmentFactorCachePath === undefined
    ? undefined
    : await resolveQueryFactorCacheIdentity(request);
  const sealedRequest = sealedDiagnosticLoopRequest(request);
  return {
    schema_version: 3,
    canonical_mode: "cache_only",
    request_identity_digest: diagnosticLoopIdentityDigest(request),
    request: sealedRequest,
    treatment_exposure_policy: CACHED_F3_EXPOSURE_POLICY,
    ...(extraction === undefined ? {} : { extraction_cache: extraction }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(query === undefined ? {} : { query_factor_cache: query })
  };
}

function sealedDiagnosticLoopRequest(
  request: DiagnosticLoopRequest
): DiagnosticLoopRequest {
  const { embeddingCacheOverlayReceiptPath: _overlay, ...sealed } = request;
  return sealed;
}

export function resolvedDiagnosticLoopIdentityDigest(
  identity: ResolvedDiagnosticLoopIdentity
): string {
  return sha256Utf8(JSON.stringify(identity));
}

export function diagnosticAuthorityDigest(value: unknown): string {
  return sha256Utf8(JSON.stringify(value));
}

export function resolveExtractionCacheIdentity(
  request: DiagnosticLoopRequest
): DiagnosticExtractionCacheIdentity {
  const root = realpathSync(resolve(request.extractionCacheRoot!));
  const identity = readExtractionCacheManifestIdentity(root);
  if (identity === undefined || !hasCompleteExtractionFillAuthority(identity.manifest)) {
    throw new Error("diagnostic-loop requires a complete extraction cache authority");
  }
  const manifest = identity.manifest as CompleteExtractionManifest;
  assertExtractionRequestBinding(manifest, request);
  assertExtractionShards(root, manifest);
  return {
    root,
    manifest_sha256: identity.manifestSha256,
    dataset_revision: manifest.dataset_revision,
    extraction_model: manifest.extraction_model,
    request_profile: manifest.request_profile,
    system_prompt_sha256: manifest.system_prompt_sha256,
    content_closure_sha256: manifest.content_closure_sha256,
    expected_key_set_sha256: manifest.expected_key_set_sha256,
    shard_count: manifest.expected_turns,
    window_offset: manifest.window_offset,
    window_limit: manifest.window_limit
  };
}

function assertExtractionRequestBinding(
  manifest: CompleteExtractionManifest,
  request: DiagnosticLoopRequest
): void {
  if (manifest.extraction_model !== request.model ||
      manifest.request_profile !== request.requestProfile ||
      manifest.dataset_revision !== request.datasetRevision ||
      manifest.system_prompt_sha256 !== request.promptDigest) {
    throw new Error("diagnostic-loop extraction cache request identity mismatch");
  }
  for (const key of request.requestedKeys) {
    if (manifest.content_closure_index[key] === undefined) {
      throw new Error(`diagnostic-loop extraction cache omits requested key ${key}`);
    }
  }
}

function assertExtractionShards(
  root: string,
  manifest: CompleteExtractionManifest
): void {
  for (const [key, expected] of Object.entries(manifest.content_closure_index)) {
    const actual = inspectCachedExtraction(
      root, key, manifest.extraction_model, manifest.request_profile
    );
    if (actual.status !== "hit" || !isDeepStrictEqual([
      actual.rawJsonSha256, actual.rawSignalCount, actual.parsedDraftCount
    ], expected)) {
      throw new Error(`diagnostic-loop extraction cache shard drifted: ${key}`);
    }
  }
}

export async function resolveSnapshotIdentity(
  snapshotPath: string,
  variant: DiagnosticLoopRequest["variant"]
): Promise<DiagnosticSnapshotIdentity> {
  const path = realpathSync(resolve(snapshotPath));
  const manifest = readSnapshotManifest(path);
  const sidecar = readSnapshotSidecar(path);
  assertSnapshotConsumerBinding({ snapshotDbPath: path, manifest, sidecar, variant });
  const extraction = assertDiagnosticManifestConsumeAuthority(manifest);
  const authority = readSnapshotAuthority(path);
  assertSnapshotExtractionAuthorityBinding(authority, extraction);
  const runProvenance = bindSnapshotRunProvenanceAuthority(
    manifest.run_provenance!, authority
  );
  assertDiagnosticSnapshotConsumeAuthority({
    extraction,
    seedExtractionPath: manifest.seed_extraction_path,
    runProvenance,
    datasetSha256: manifest.dataset_sha256!
  });
  await verifySnapshotArtifactIntegrity(path, manifest.artifact_integrity!);
  const integrity = await buildSnapshotArtifactIntegrity(path);
  const questionDigest = snapshotQuestionIdDigest(sidecar.questions);
  const base = {
    path,
    db_sha256: integrity.db_sha256,
    manifest_sha256: await sha256File(snapshotManifestPath(path)),
    sidecar_sha256: integrity.sidecar_sha256,
    extraction_authority_sha256: integrity.extraction_authority_sha256!,
    question_count: sidecar.questions.length,
    question_ids: sidecar.questions.map((question) => question.questionId),
    question_id_digest: questionDigest,
    dataset_sha256: manifest.dataset_sha256!,
    extraction_binding: snapshotExtractionBinding(authority)
  };
  return { ...base, identity_digest: diagnosticAuthorityDigest(base) };
}

function snapshotExtractionBinding(
  authority: ReturnType<typeof readSnapshotAuthority>
): DiagnosticExtractionAuthorityBinding {
  return {
    manifest_sha256: authority.source_manifest_sha256,
    dataset_revision: authority.dataset_revision,
    extraction_model: authority.extraction_model,
    request_profile: authority.request_profile,
    system_prompt_sha256: authority.system_prompt_sha256,
    content_closure_sha256: authority.content_closure_sha256,
    expected_key_set_sha256: authority.expected_key_set_sha256,
    shard_count: authority.expected_turns,
    window_offset: authority.window_offset,
    window_limit: authority.window_limit
  };
}

function readSnapshotAuthority(snapshotPath: string) {
  const authorityPath = snapshotExtractionAuthorityPath(snapshotPath);
  return parseSnapshotExtractionAuthorityBytes(
    readRegularFileNoFollow(authorityPath, MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES),
    authorityPath
  );
}

async function resolveQueryFactorCacheIdentity(
  request: DiagnosticLoopRequest
): Promise<DiagnosticQueryFactorCacheIdentity> {
  const path = request.treatmentFactorCachePath;
  if (path === undefined) {
    throw new Error("query semantic factor cache path is required");
  }
  if (request.snapshotPath === undefined) {
    throw new Error("query semantic factor cache current bind requires a request source set");
  }
  const bound = await bindQuerySemanticFactorCacheFileToRequest(path, request);
  return {
    path: resolve(path),
    file_sha256: bound.file_sha256,
    ...bound.binding
  };
}
