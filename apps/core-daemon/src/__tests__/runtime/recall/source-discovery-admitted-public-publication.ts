import {
  fieldContractSha256
} from "../../../../../../packages/core/src/shared/field-hash.js";
import type { FieldContractSha256, SourceLocatedInterpretation } from "@do-soul/alaya-protocol";
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
  inspectCachedExtraction,
  inspectCachedRawExtraction,
  type CachedExtractionInspection
} from "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-shard.js";
import { computeCacheKey } from
  "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-key.js";
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
  readonly requestProfile: Parameters<typeof inspectCachedExtraction>[3];
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

export function bindReceivedExtractionShard(input: Readonly<{
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: Parameters<typeof inspectCachedExtraction>[3];
  readonly systemPrompt: string;
  readonly sourceCorpus: string;
  readonly artifactKey: string;
  readonly request?: OfficialApiExtractionRequest;
  readonly cacheKey?: string;
  readonly sha256?: FieldContractSha256;
}>): BoundPublicReceive {
  const packed = requirePackedRequest(input.request, input.sourceCorpus);
  if (packed.status !== "ok") return packed.bind;
  const derivedKey = expectedExtractionCacheKey({
    model: input.model,
    requestProfile: input.requestProfile,
    systemPrompt: input.systemPrompt,
    request: packed.request
  });
  if (input.cacheKey !== undefined && input.cacheKey !== derivedKey) {
    return {
      status: "invalid",
      reason: "generation_identity_mismatch",
      cacheKey: derivedKey
    };
  }
  const inspected = inspectCachedExtraction(
    input.cacheRoot, derivedKey, input.model, input.requestProfile
  );
  if (inspected.status === "missing") return { status: "missing", cacheKey: derivedKey };
  if (inspected.status !== "hit") {
    return { ...invalidBind(inspected), cacheKey: derivedKey };
  }
  const raw = inspectCachedRawExtraction(
    input.cacheRoot, derivedKey, input.model, input.requestProfile
  );
  const provenance: BoundPublicProvenance = raw.status === "hit" && raw.transportProvenance !== undefined
    ? "cache-admitted"
    : "cache-authored";
  const receive = receiveOfficialApiSourceInterpretations(inspected.rawJson, packed.request, {
    sourceCorpus: input.sourceCorpus,
    artifactKey: input.artifactKey,
    sha256: input.sha256 ?? fieldContractSha256
  });
  return {
    status: receive.status,
    rawJson: inspected.rawJson,
    receive,
    provenance,
    cacheKey: derivedKey
  };
}

export function bindAdmittedActualModelShard(input: Parameters<typeof bindReceivedExtractionShard>[0]): BoundPublicReceive {
  const bound = bindReceivedExtractionShard(input);
  if (bound.status === "missing") {
    return { status: "not_exercised", reason: "missing_admitted_shard", cacheKey: bound.cacheKey };
  }
  if (bound.status === "invalid") {
    return { status: "not_exercised", reason: bound.reason, cacheKey: bound.cacheKey };
  }
  if (bound.status === "partial") {
    return { status: "not_exercised", reason: "quarantined_admission", cacheKey: bound.cacheKey };
  }
  if (bound.status !== "complete" || bound.provenance !== "cache-admitted") {
    return {
      status: "not_exercised",
      reason: bound.status === "complete" ? bound.provenance : bound.status,
      cacheKey: bound.status === "complete" || bound.status === "not_exercised" ? bound.cacheKey : undefined
    };
  }
  return bound;
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
