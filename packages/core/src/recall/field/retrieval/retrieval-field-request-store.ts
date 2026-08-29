import type { KeywordSearchFieldResult } from
  "../../runtime/recall-service-types.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import type {
  FieldObjectKind,
  FieldPrefix,
  FieldSource,
  RecallRetrievalFieldBundleSource,
  RecordedFieldResult
} from "./retrieval-field-bundle.js";
import {
  FieldResultLimitError,
  freezeFieldResult
} from "./retrieval-field-validation.js";
import {
  authenticateValidatedRetrievalFieldRecord,
  type RetrievalFieldSourceAuthority
} from "./retrieval-field-source-authority.js";

export type RetrievalFieldBatchFailure = Readonly<{
  readonly failureClass:
    | "result_count_mismatch"
    | "result_limit_exceeded"
    | "result_shape_mismatch"
    | "service_error";
  readonly returnedCount: number | null;
  readonly validResultCount: number | null;
  readonly invalidIndex: number | null;
  readonly errorName: string | null;
  readonly errorMessage: string | null;
}>;

export type RetrievalFieldRequest = Readonly<{
  readonly prefix: FieldPrefix;
  readonly source: FieldSource;
  readonly objectKind: FieldObjectKind;
  readonly identity: unknown;
  readonly operation: string;
  readonly maxMatches: number;
  readonly invoke?: () => Promise<Readonly<KeywordSearchFieldResult>>;
}>;

export interface RetrievalFieldRequestStore {
  readonly search: (
    request: RetrievalFieldRequest
  ) => Promise<Readonly<KeywordSearchFieldResult>>;
  readonly searchBatch: (params: Readonly<{
    readonly operation: string;
    readonly requests: readonly RetrievalFieldRequest[];
    readonly invoke?: () => Promise<unknown>;
  }>) => Promise<readonly Readonly<KeywordSearchFieldResult>[]>;
}

export function createRetrievalFieldRequestStore(
  bundle: RecallRetrievalFieldBundleSource,
  records: RecordedFieldResult[],
  sourceAuthority: RetrievalFieldSourceAuthority
): Readonly<RetrievalFieldRequestStore> {
  const cache = new Map<string, Promise<Readonly<KeywordSearchFieldResult>>>();
  const search = createScalarSearch(bundle, records, cache, sourceAuthority);
  return Object.freeze({
    search,
    searchBatch: async (
      params: Parameters<RetrievalFieldRequestStore["searchBatch"]>[0]
    ) => await runBatchSearch(
      bundle,
      records,
      cache,
      search,
      sourceAuthority,
      params
    )
  });
}

function createScalarSearch(
  bundle: RecallRetrievalFieldBundleSource,
  records: RecordedFieldResult[],
  cache: Map<string, Promise<Readonly<KeywordSearchFieldResult>>>,
  sourceAuthority: RetrievalFieldSourceAuthority
) {
  return async (request: RetrievalFieldRequest): Promise<Readonly<KeywordSearchFieldResult>> => {
    const requestDigest = fieldRequestDigest(bundle.workspaceId, request);
    const cached = cache.get(requestDigest);
    if (cached !== undefined) return await cached;
    const pending = runScalarSearch(
      bundle, records, request, requestDigest, sourceAuthority
    );
    cache.set(requestDigest, pending);
    try {
      return await pending;
    } catch (error) {
      if (cache.get(requestDigest) === pending) cache.delete(requestDigest);
      throw error;
    }
  };
}

async function runScalarSearch(
  bundle: RecallRetrievalFieldBundleSource,
  records: RecordedFieldResult[],
  request: RetrievalFieldRequest,
  requestDigest: RecallFieldDigest,
  sourceAuthority: RetrievalFieldSourceAuthority
): Promise<Readonly<KeywordSearchFieldResult>> {
  if (request.invoke === undefined) {
    const unavailable = unavailableFieldResult();
    recordFieldResult(records, request, requestDigest, unavailable);
    return unavailable;
  }
  try {
    const result = freezeFieldResult(await request.invoke(), request.maxMatches);
    const record = recordFieldResult(records, request, requestDigest, result);
    authenticateValidatedRetrievalFieldRecord(sourceAuthority, record);
    return result;
  } catch (error) {
    recordFieldResult(records, request, requestDigest, unavailableFieldResult());
    bundle.onFailure?.(request.operation, error);
    throw error;
  }
}

async function runBatchSearch(
  bundle: RecallRetrievalFieldBundleSource,
  records: RecordedFieldResult[],
  cache: Map<string, Promise<Readonly<KeywordSearchFieldResult>>>,
  search: RetrievalFieldRequestStore["search"],
  sourceAuthority: RetrievalFieldSourceAuthority,
  params: Parameters<RetrievalFieldRequestStore["searchBatch"]>[0]
): Promise<readonly Readonly<KeywordSearchFieldResult>[]> {
  if (params.requests.length === 0) return Object.freeze([]);
  const digests = params.requests.map((request) =>
    fieldRequestDigest(bundle.workspaceId, request)
  );
  if (params.invoke === undefined || !canUseBatch(cache, digests)) {
    return await runScalarFallback(params.requests, search);
  }
  const outcome = await tryBatchSearch(params.invoke, params.requests);
  if (outcome.kind === "failure") {
    bundle.onBatchFailure?.(params.operation, outcome.failure);
    return await runScalarFallback(params.requests, search);
  }
  seedBatchResults(
    records, cache, params.requests, digests, outcome.results, sourceAuthority
  );
  return outcome.results;
}

function canUseBatch(
  cache: ReadonlyMap<string, Promise<Readonly<KeywordSearchFieldResult>>>,
  digests: readonly string[]
): boolean {
  return new Set(digests).size === digests.length &&
    digests.every((digest) => !cache.has(digest));
}

async function tryBatchSearch(
  invoke: () => Promise<unknown>,
  requests: readonly RetrievalFieldRequest[]
): Promise<BatchOutcome> {
  try {
    return validateBatchResult(await invoke(), requests);
  } catch (error) {
    return batchFailure("service_error", {
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
}

type BatchOutcome = Readonly<
  | {
    readonly kind: "success";
    readonly results: readonly Readonly<KeywordSearchFieldResult>[];
  }
  | { readonly kind: "failure"; readonly failure: RetrievalFieldBatchFailure }
>;

function validateBatchResult(
  value: unknown,
  requests: readonly RetrievalFieldRequest[]
): BatchOutcome {
  if (!Array.isArray(value)) return batchFailure("result_shape_mismatch");
  if (value.length !== requests.length) {
    return batchFailure("result_count_mismatch", { returnedCount: value.length });
  }
  const results: Readonly<KeywordSearchFieldResult>[] = [];
  for (let index = 0; index < value.length; index += 1) {
    try {
      results.push(freezeFieldResult(value[index], requests[index]!.maxMatches));
    } catch (error) {
      return batchFailure(
        error instanceof FieldResultLimitError
          ? "result_limit_exceeded"
          : "result_shape_mismatch",
        { returnedCount: value.length, validResultCount: index, invalidIndex: index }
      );
    }
  }
  return Object.freeze({ kind: "success", results: Object.freeze(results) });
}

function seedBatchResults(
  records: RecordedFieldResult[],
  cache: Map<string, Promise<Readonly<KeywordSearchFieldResult>>>,
  requests: readonly RetrievalFieldRequest[],
  digests: readonly RecallFieldDigest[],
  results: readonly Readonly<KeywordSearchFieldResult>[],
  sourceAuthority: RetrievalFieldSourceAuthority
): void {
  results.forEach((result, index) => {
    const request = requests[index]!;
    const digest = digests[index]!;
    const record = recordFieldResult(records, request, digest, result);
    authenticateValidatedRetrievalFieldRecord(sourceAuthority, record);
    cache.set(digest, Promise.resolve(result));
  });
}

async function runScalarFallback(
  requests: readonly RetrievalFieldRequest[],
  search: RetrievalFieldRequestStore["search"]
): Promise<readonly Readonly<KeywordSearchFieldResult>[]> {
  return Object.freeze(await Promise.all(requests.map(search)));
}

function fieldRequestDigest(
  workspaceId: string,
  request: RetrievalFieldRequest
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    workspace_id: workspaceId,
    prefix: request.prefix,
    source: request.source,
    request: request.identity
  });
}

function recordFieldResult(
  records: RecordedFieldResult[],
  request: RetrievalFieldRequest,
  requestDigest: RecallFieldDigest,
  result: Readonly<KeywordSearchFieldResult>
): RecordedFieldResult {
  const record = Object.freeze({
    request_digest: requestDigest,
    prefix: request.prefix,
    source: request.source,
    object_kind: request.objectKind,
    requested_depth: request.maxMatches,
    result
  });
  records.push(record);
  return record;
}

function unavailableFieldResult(): Readonly<KeywordSearchFieldResult> {
  return Object.freeze({
    matches: Object.freeze([]),
    lanes: Object.freeze(([
      "exact", "porter", "trigram"
    ] as const).map((lane) => Object.freeze({
      lane,
      status: "unavailable" as const,
      depth: 0,
      observations: Object.freeze([]),
      unseen_upper_bound: null
    })))
  });
}

function batchFailure(
  failureClass: RetrievalFieldBatchFailure["failureClass"],
  details: Partial<Omit<RetrievalFieldBatchFailure, "failureClass">> = {}
): BatchOutcome {
  return Object.freeze({
    kind: "failure",
    failure: Object.freeze({
      failureClass,
      returnedCount: details.returnedCount ?? null,
      validResultCount: details.validResultCount ?? null,
      invalidIndex: details.invalidIndex ?? null,
      errorName: details.errorName ?? null,
      errorMessage: details.errorMessage ?? null
    })
  });
}
