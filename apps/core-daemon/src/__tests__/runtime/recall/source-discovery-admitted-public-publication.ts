import {
  fieldContractSha256
} from "../../../../../../packages/core/src/shared/field-hash.js";
import type { FieldContractSha256, SourceLocatedInterpretation } from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
  buildOfficialApiSourceAssertions,
  buildOfficialApiSourceRequest,
  receiveOfficialApiSourceInterpretations,
  type OfficialApiExtractionRequest,
  type OfficialApiInterpretationReceiveReceipt
} from "@do-soul/alaya-soul";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import {
  inspectCachedExtraction,
  type CachedExtractionInspection
} from "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-shard.js";
import { insertLocatedBoundGist } from "./source-discovery-public-consumption.js";

export type AdmittedSourceRecord = Readonly<{
  readonly body: string;
  readonly rootId: string;
  readonly digest: string;
  readonly evidenceObjectId: string | null;
}>;

export type AdmittedPublicBind =
  | Readonly<{
      readonly status: "received";
      readonly rawJson: string;
      readonly receive: OfficialApiInterpretationReceiveReceipt;
    }>
  | Readonly<{
      readonly status: "unbound";
      readonly reason: "catalog_exceeds_batch";
    }>
  | Readonly<{
      readonly status: Exclude<CachedExtractionInspection["status"], "hit">;
      readonly reason?: string;
    }>;

export type AdmittedPublicPublication = Readonly<{
  readonly bind: AdmittedPublicBind;
  readonly gist_object_ids: readonly string[];
}>;

export function bindAdmittedSourceInterpretationPayload(input: Readonly<{
  readonly rawJson: string;
  readonly sourceCorpus: string;
  readonly artifactKey: string;
  readonly request?: OfficialApiExtractionRequest;
  readonly sha256?: FieldContractSha256;
}>): AdmittedPublicBind {
  const request = input.request ?? requestFromCorpus(input.sourceCorpus);
  if (request === "catalog_exceeds_batch") {
    return { status: "unbound", reason: "catalog_exceeds_batch" };
  }
  return {
    status: "received",
    rawJson: input.rawJson,
    receive: receiveOfficialApiSourceInterpretations(input.rawJson, request, {
      sourceCorpus: input.sourceCorpus,
      artifactKey: input.artifactKey,
      sha256: input.sha256 ?? fieldContractSha256
    })
  };
}

export function bindAdmittedExtractionShard(input: Readonly<{
  readonly cacheRoot: string;
  readonly cacheKey: string;
  readonly model: string;
  readonly requestProfile: Parameters<typeof inspectCachedExtraction>[3];
  readonly sourceCorpus: string;
  readonly artifactKey: string;
  readonly request?: OfficialApiExtractionRequest;
  readonly sha256?: FieldContractSha256;
}>): AdmittedPublicBind {
  const inspected = inspectCachedExtraction(
    input.cacheRoot, input.cacheKey, input.model, input.requestProfile
  );
  if (inspected.status !== "hit") {
    return inspected.status === "missing"
      ? { status: "missing" }
      : { status: inspected.status, reason: inspected.reason };
  }
  return bindAdmittedSourceInterpretationPayload({
    rawJson: inspected.rawJson,
    sourceCorpus: input.sourceCorpus,
    artifactKey: input.artifactKey,
    ...(input.request === undefined ? {} : { request: input.request }),
    ...(input.sha256 === undefined ? {} : { sha256: input.sha256 })
  });
}

export function publishAdmittedPublicSources(input: Readonly<{
  readonly database: StorageDatabase;
  readonly source: AdmittedSourceRecord;
  readonly workspaceId: string;
  readonly runId: string;
  readonly now: string;
  readonly bind: AdmittedPublicBind;
}>): AdmittedPublicPublication {
  if (input.bind.status !== "received") {
    return { bind: input.bind, gist_object_ids: [] };
  }
  const gistObjectIds = input.bind.receive.located.map((located, index) => {
    const objectId = admittedGistObjectId(input.source.rootId, located, index);
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
    return objectId;
  });
  return { bind: input.bind, gist_object_ids: gistObjectIds };
}

function requestFromCorpus(
  sourceCorpus: string
): OfficialApiExtractionRequest | "catalog_exceeds_batch" {
  const ids = buildOfficialApiSourceAssertions(sourceCorpus).map((row) => row.assertion_id);
  if (ids.length > OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH) return "catalog_exceeds_batch";
  return buildOfficialApiSourceRequest(sourceCorpus, ids);
}

function admittedGistObjectId(
  rootId: string,
  located: SourceLocatedInterpretation,
  index: number
): string {
  return `admitted-gist-${rootId}-${located.assertion_binding.assertion_id}-${index}`;
}
