import {
  fieldContractSha256
} from "../../../../../../packages/core/src/shared/field-hash.js";
import {
  DEFAULT_EXTRACTION_SOURCE_PACKING,
  type FieldContractSha256,
  type SourceLocatedInterpretation
} from "@do-soul/alaya-protocol";
import {
  computeOfficialApiSourceCorpusIdentity,
  receiveOfficialApiSourceInterpretations,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest,
  type OfficialApiInterpretationReceiveReceipt
} from "@do-soul/alaya-soul";
import { indexOfficialApiSourceAssertions } from
  "../../../../../../packages/soul/src/garden/triage/grounding/source-locator.js";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import {
  inspectCachedExtractionContent,
  readCachedEntry,
  type CachedExtractionEntry,
  type CachedExtractionInspection
} from "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-shard.js";
import { computeCacheKey } from
  "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-key.js";
import {
  readExtractionCacheManifestIdentity,
  type ExtractionCacheManifestIdentity
} from "../../../../../../apps/bench-runner/src/runs/extraction/cache/extraction-cache-manifest.js";
import { assertExtractionCacheIdentity } from
  "../../../../../../apps/bench-runner/src/runs/extraction/cache/cache-identity.js";
import { computeExtractionRawJsonSha256 } from
  "../../../../../../apps/bench-runner/src/runs/extraction/content-closure.js";
import { buildExtractionTransportProvenance } from
  "../../../../../../apps/bench-runner/src/runs/extraction/transport-route.js";
import { insertLocatedBoundGist } from "./source-discovery-public-consumption.js";

export type BoundPublicSource = Readonly<{
  readonly body: string;
  readonly rootId: string;
  readonly digest: string;
  readonly evidenceObjectId: string | null;
}>;

export type BoundPublicProvenance =
  | "payload"
  | "native-admitted-control"
  | "cache-authored"
  | "cache-admitted";

export type BoundPublicReceive =
  | Readonly<{
      readonly status: "complete" | "partial";
      readonly rawJson: string;
      readonly receive: OfficialApiInterpretationReceiveReceipt;
      readonly provenance: BoundPublicProvenance;
      readonly cacheKey?: string;
    }>
  | Readonly<{
      readonly status: "missing";
      readonly cacheKey?: string;
    }>
  | Readonly<{
      readonly status: "invalid";
      readonly reason: string;
      readonly cacheKey?: string;
    }>
  | Readonly<{
      readonly status: "not_exercised";
      readonly reason: string;
      readonly cacheKey?: string;
    }>;

export type BoundPublicPublication = Readonly<{
  readonly bind: BoundPublicReceive;
  readonly gist_object_ids: readonly string[];
}>;

export function bindReceivedSourceInterpretationPayload(input: Readonly<{
  readonly rawJson: string;
  readonly sourceCorpus: string;
  readonly artifactKey: string;
  readonly request?: OfficialApiExtractionRequest;
  readonly sha256?: FieldContractSha256;
  readonly provenance?: Exclude<BoundPublicProvenance, "cache-authored" | "cache-admitted">;
}>): BoundPublicReceive {
  const packed = requirePackedRequest(input.request, input.sourceCorpus);
  if (packed.status !== "ok") return packed.bind;
  const receive = receiveOfficialApiSourceInterpretations(input.rawJson, packed.request, {
    sourceCorpus: input.sourceCorpus,
    artifactKey: input.artifactKey,
    sha256: input.sha256 ?? fieldContractSha256
  });
  return {
    status: receive.status,
    rawJson: input.rawJson,
    receive,
    provenance: input.provenance ?? "payload"
  };
}

export function expectedExtractionCacheKey(input: Readonly<{
  readonly model: string;
  readonly requestProfile: Parameters<typeof readCachedEntry>[3];
  readonly systemPrompt: string;
  readonly request: OfficialApiExtractionRequest;
}>): string {
  return computeCacheKey(
    input.model,
    input.requestProfile,
    input.systemPrompt,
    stringifyOfficialApiExtractionRequest(input.request)
  );
}

type ExtractionShardBindInput = Readonly<{
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: Parameters<typeof readCachedEntry>[3];
  readonly systemPrompt: string;
  readonly sourceCorpus: string;
  readonly artifactKey: string;
  readonly request?: OfficialApiExtractionRequest;
  readonly cacheKey?: string;
  readonly sha256?: FieldContractSha256;
  readonly modelFamily?: string;
  readonly providerUrl?: string;
  readonly sourcePacking?: typeof DEFAULT_EXTRACTION_SOURCE_PACKING;
}>;

type ExtractionShardSnapshot =
  | Readonly<{ readonly kind: "bind"; readonly bind: BoundPublicReceive }>
  | Readonly<{
      readonly kind: "entry";
      readonly derivedKey: string;
      readonly request: OfficialApiExtractionRequest;
      readonly entry: CachedExtractionEntry;
      readonly manifestIdentity: ExtractionCacheManifestIdentity | undefined;
    }>;

export function bindReceivedExtractionShard(input: ExtractionShardBindInput): BoundPublicReceive {
  const snapshot = takeExtractionShardSnapshot(input);
  if (snapshot.kind === "bind") return snapshot.bind;
  return receiveFromShardSnapshot(input, snapshot);
}

export function bindAdmittedActualModelShard(input: ExtractionShardBindInput): BoundPublicReceive {
  const snapshot = takeExtractionShardSnapshot(input);
  if (snapshot.kind === "bind") {
    if (snapshot.bind.status === "missing") {
      return { status: "not_exercised", reason: "missing_admitted_shard", cacheKey: snapshot.bind.cacheKey };
    }
    if (snapshot.bind.status === "invalid") {
      return { status: "not_exercised", reason: snapshot.bind.reason, cacheKey: snapshot.bind.cacheKey };
    }
    return { status: "not_exercised", reason: snapshot.bind.status, cacheKey: snapshot.bind.cacheKey };
  }
  if (snapshot.entry.transport_provenance !== undefined && snapshot.entry.request_completion === undefined) {
    return { status: "not_exercised", reason: "unbound_transport_metadata", cacheKey: snapshot.derivedKey };
  }
  if (snapshot.entry.transport_provenance === undefined || snapshot.entry.request_completion === undefined) {
    const authored = receiveFromShardSnapshot(input, snapshot);
    if (authored.status === "partial") {
      return { status: "not_exercised", reason: "quarantined_admission", cacheKey: authored.cacheKey };
    }
    return {
      status: "not_exercised",
      reason: "cache-authored",
      cacheKey: snapshot.derivedKey
    };
  }
  const identityGap = actualModelIdentityGap(input, snapshot);
  if (identityGap !== null) {
    return { status: "not_exercised", reason: identityGap, cacheKey: snapshot.derivedKey };
  }
  const bound = receiveFromShardSnapshot(input, snapshot);
  if (bound.status !== "complete") {
    return { status: "not_exercised", reason: "quarantined_admission", cacheKey: bound.cacheKey };
  }
  return { ...bound, provenance: "cache-admitted" };
}

export function publishBoundPublicSources(input: Readonly<{
  readonly database: StorageDatabase;
  readonly source: BoundPublicSource;
  readonly workspaceId: string;
  readonly runId: string;
  readonly now: string;
  readonly bind: BoundPublicReceive;
}>): BoundPublicPublication {
  if (input.bind.status !== "complete") {
    return { bind: input.bind, gist_object_ids: [] };
  }
  const gistObjectIds: string[] = [];
  for (const located of input.bind.receive.located) {
    if (located.outcome !== "candidates") continue;
    const objectId = boundGistObjectId(input.workspaceId, input.source.digest, located);
    insertLocatedBoundGist(
      input.database,
      objectId,
      input.source.body,
      input.source.rootId,
      input.source.digest,
      input.source.evidenceObjectId,
      located,
      input.workspaceId,
      input.runId,
      input.now
    );
    gistObjectIds.push(objectId);
  }
  return { bind: input.bind, gist_object_ids: gistObjectIds };
}

export function requireCompletePublicBind(
  bind: BoundPublicReceive
): Extract<BoundPublicReceive, { readonly status: "complete" }> {
  if (bind.status !== "complete") {
    throw new Error(`public bind ${bind.status}`);
  }
  return bind;
}

export function requirePartialPublicBind(
  bind: BoundPublicReceive
): Extract<BoundPublicReceive, { readonly status: "partial" }> {
  if (bind.status !== "partial") {
    throw new Error(`public bind ${bind.status}`);
  }
  return bind;
}

function takeExtractionShardSnapshot(input: ExtractionShardBindInput): ExtractionShardSnapshot {
  const packed = requirePackedRequest(input.request, input.sourceCorpus);
  if (packed.status !== "ok") return { kind: "bind", bind: packed.bind };
  const derivedKey = expectedExtractionCacheKey({
    model: input.model,
    requestProfile: input.requestProfile,
    systemPrompt: input.systemPrompt,
    request: packed.request
  });
  if (input.cacheKey !== undefined && input.cacheKey !== derivedKey) {
    return {
      kind: "bind",
      bind: { status: "invalid", reason: "generation_identity_mismatch", cacheKey: derivedKey }
    };
  }
  const cached = readCachedEntry(input.cacheRoot, derivedKey, input.model, input.requestProfile);
  if (cached.status === "missing") {
    return { kind: "bind", bind: { status: "missing", cacheKey: derivedKey } };
  }
  if (cached.status !== "hit") {
    return { kind: "bind", bind: { status: "invalid", reason: cached.reason, cacheKey: derivedKey } };
  }
  const inspected = inspectCachedExtractionContent(cached.entry);
  if (inspected.status !== "hit") {
    return { kind: "bind", bind: { ...invalidBind(inspected), cacheKey: derivedKey } };
  }
  let manifestIdentity: ExtractionCacheManifestIdentity | undefined;
  try {
    manifestIdentity = readExtractionCacheManifestIdentity(input.cacheRoot);
  } catch {
    return {
      kind: "bind",
      bind: { status: "invalid", reason: "invalid_cache_manifest", cacheKey: derivedKey }
    };
  }
  return {
    kind: "entry",
    derivedKey,
    request: packed.request,
    entry: cached.entry,
    manifestIdentity
  };
}

function receiveFromShardSnapshot(
  input: ExtractionShardBindInput,
  snapshot: Extract<ExtractionShardSnapshot, { readonly kind: "entry" }>
): BoundPublicReceive {
  const receive = receiveOfficialApiSourceInterpretations(snapshot.entry.raw_json, snapshot.request, {
    sourceCorpus: input.sourceCorpus,
    artifactKey: input.artifactKey,
    sha256: input.sha256 ?? fieldContractSha256
  });
  return {
    status: receive.status,
    rawJson: snapshot.entry.raw_json,
    receive,
    provenance: "cache-authored",
    cacheKey: snapshot.derivedKey
  };
}

function actualModelIdentityGap(
  input: ExtractionShardBindInput,
  snapshot: Extract<ExtractionShardSnapshot, { readonly kind: "entry" }>
): string | null {
  const identity = snapshot.manifestIdentity;
  if (identity === undefined) return "missing_cache_manifest";
  if (input.modelFamily === undefined) return "missing_model_family";
  if (input.providerUrl === undefined) return "missing_provider_url";
  if (input.sourcePacking === undefined) return "missing_source_packing";
  try {
    assertExtractionCacheIdentity({
      config: {
        model: input.model,
        modelFamily: input.modelFamily,
        providerUrl: input.providerUrl,
        requestProfile: input.requestProfile,
        sourcePacking: input.sourcePacking
      },
      systemPrompt: input.systemPrompt,
      manifest: identity.manifest,
      validateProvider: true
    });
  } catch {
    return "cache_identity_mismatch";
  }
  const transport = snapshot.entry.transport_provenance;
  if (transport === undefined) return "unbound_transport_metadata";
  const expected = buildExtractionTransportProvenance({
    model: input.model,
    providerUrl: input.providerUrl
  });
  if (transport.model !== expected.model || transport.provider_url_sha256 !== expected.provider_url_sha256) {
    return "transport_generation_mismatch";
  }
  const admission = snapshot.entry.admission_identity;
  if (admission === undefined) return "missing_admission_identity";
  if (admission.manifest_sha256 !== identity.manifestSha256) return "admission_manifest_mismatch";
  if (admission.raw_json_sha256 !== computeExtractionRawJsonSha256(snapshot.entry.raw_json)) {
    return "admission_payload_mismatch";
  }
  return null;
}

function requirePackedRequest(
  request: OfficialApiExtractionRequest | undefined,
  sourceCorpus: string
): Readonly<{ readonly status: "ok"; readonly request: OfficialApiExtractionRequest }>
  | Readonly<{ readonly status: "invalid"; readonly bind: BoundPublicReceive }> {
  if (request === undefined) {
    return { status: "invalid", bind: { status: "invalid", reason: "packed_request_required" } };
  }
  if (!packedRequestMatchesCatalog(request, sourceCorpus)) {
    return { status: "invalid", bind: { status: "invalid", reason: "source_assertion_mismatch" } };
  }
  return { status: "ok", request };
}

function packedRequestMatchesCatalog(
  request: OfficialApiExtractionRequest,
  sourceCorpus: string
): boolean {
  if (computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    return false;
  }
  const catalog = new Map(
    indexOfficialApiSourceAssertions(sourceCorpus).map((row) => [row.assertion_id, row.text] as const)
  );
  return request.source_assertions.length > 0
    && request.source_assertions.every((member) => catalog.get(member.assertion_id) === member.text);
}

function invalidBind(
  inspected: Extract<CachedExtractionInspection, { readonly status: "invalid" | "quarantined" }>
): BoundPublicReceive {
  return { status: "invalid", reason: inspected.reason };
}

function boundGistObjectId(
  workspaceId: string,
  contentDigest: string,
  located: SourceLocatedInterpretation
): string {
  return [
    "bound-gist",
    workspaceId,
    contentDigest,
    String(located.assertion_binding.assertion_id),
    located.assertion_binding.context_id
  ].join("-");
}
