import type {
  KeywordSearchBatchQuery,
  KeywordSearchFieldResult,
  KeywordSearchLaneScope,
  KeywordSearchResult,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServiceSynthesisSearchPort
} from "../../runtime/recall-service-types.js";
import type { RecallFiniteFieldChannelCapture } from "../finite-field-capture.js";
import type { RecallFieldDigest } from "../field-identity.js";
import {
  createRecallRetrievalFieldRefinementReceipt,
  type RecallRetrievalFieldRefinementReceipt
} from "../refinement/field-refinement-receipt.js";
import { materializeRetrievalFieldBundleCaptures } from
  "./retrieval-field-captures.js";
import {
  createRetrievalFieldRequestStore,
  type RetrievalFieldBatchFailure,
  type RetrievalFieldRequest,
  type RetrievalFieldRequestStore
} from "./retrieval-field-request-store.js";

export type RecallMemoryFieldVariant =
  | "lexical_relaxed"
  | "lexical_expanded";
export type RecallRetrievalFieldObservationView = "requested" | "maximum";

export interface RecallRetrievalFieldBundle {
  readonly observationView: RecallRetrievalFieldObservationView;
  readonly maximumObservationAvailable: () => boolean;
  readonly forObservationView: (
    view: RecallRetrievalFieldObservationView
  ) => Readonly<RecallRetrievalFieldBundle>;
  readonly searchMemoryKeyword: (params: Readonly<{
    readonly variant: RecallMemoryFieldVariant;
    readonly queryText: string;
    readonly limit: number;
    readonly scope: Readonly<KeywordSearchLaneScope>;
  }>) => Promise<readonly Readonly<KeywordSearchResult>[]>;
  readonly searchMemoryAnchor: (params: Readonly<{
    readonly anchorTokens: readonly string[];
    readonly optionalTokens: readonly string[];
    readonly limit: number;
    readonly scope: Readonly<KeywordSearchLaneScope>;
  }>) => Promise<readonly Readonly<KeywordSearchResult>[]>;
  readonly searchEvidenceKeyword: (params: Readonly<{
    readonly queryText: string;
    readonly limit: number;
  }>) => Promise<readonly Readonly<KeywordSearchResult>[]>;
  readonly searchEvidenceKeywords: (params: Readonly<{
    readonly queries: readonly Readonly<KeywordSearchBatchQuery>[];
  }>) => Promise<readonly (readonly Readonly<KeywordSearchResult>[])[]>;
  readonly searchSynthesisKeyword: (params: Readonly<{
    readonly queryText: string;
    readonly limit: number;
  }>) => Promise<readonly Readonly<KeywordSearchResult>[]>;
  readonly searchSynthesisKeywords: (params: Readonly<{
    readonly queries: readonly Readonly<KeywordSearchBatchQuery>[];
  }>) => Promise<readonly (readonly Readonly<KeywordSearchResult>[])[]>;
  readonly captures: () => readonly Readonly<RecallFiniteFieldChannelCapture>[];
  readonly refinementReceipts: () =>
    readonly Readonly<RecallRetrievalFieldRefinementReceipt>[];
}

export type FieldPrefix =
  | RecallMemoryFieldVariant
  | "lexical_anchor"
  | "evidence_fts"
  | "synthesis_fts";
export type FieldSource = "memory" | "evidence" | "synthesis";
export type FieldObjectKind = "memory_entry" | "evidence_capsule" | "synthesis_capsule";
export type RecordedFieldResult = Readonly<{
  readonly request_digest: RecallFieldDigest;
  readonly prefix: FieldPrefix;
  readonly source: FieldSource;
  readonly object_kind: FieldObjectKind;
  readonly requested_depth: number;
  readonly result: Readonly<KeywordSearchFieldResult>;
}>;

export type RecallRetrievalFieldBundleSource = Readonly<{
  readonly workspaceId: string;
  readonly queryText: string | null;
  readonly memoryRepo: Readonly<RecallServiceMemoryRepoPort>;
  readonly evidenceSearchPort?: Readonly<RecallServiceEvidenceSearchPort>;
  readonly synthesisSearchPort?: Readonly<RecallServiceSynthesisSearchPort>;
  readonly refinementMaxDepth?: number;
  readonly onFailure?: (operation: string, error: unknown) => void;
  readonly onBatchFailure?: (
    operation: string,
    failure: RetrievalFieldBatchFailure
  ) => void;
}>;

export function createRecallRetrievalFieldBundle(
  params: RecallRetrievalFieldBundleSource
): Readonly<RecallRetrievalFieldBundle> {
  const records: RecordedFieldResult[] = [];
  const store = createRetrievalFieldRequestStore(params, records);
  let requested: Readonly<RecallRetrievalFieldBundle>;
  let maximum: Readonly<RecallRetrievalFieldBundle>;
  const forObservationView = (view: RecallRetrievalFieldObservationView) =>
    view === "requested" ? requested : maximum;
  requested = createBundleView(params, store, records, "requested", forObservationView);
  maximum = createBundleView(params, store, records, "maximum", forObservationView);
  return requested;
}

function createBundleView(
  params: RecallRetrievalFieldBundleSource,
  store: Readonly<RetrievalFieldRequestStore>,
  records: RecordedFieldResult[],
  observationView: RecallRetrievalFieldObservationView,
  forObservationView: RecallRetrievalFieldBundle["forObservationView"]
): Readonly<RecallRetrievalFieldBundle> {
  return Object.freeze({
    observationView,
    maximumObservationAvailable: () => records.some((record) =>
      (record.result.refinement_levels?.length ?? 0) > 0
    ),
    forObservationView,
    ...createMemoryFieldSearches(params, store, observationView),
    ...createEvidenceFieldSearches(params, store, observationView),
    ...createSynthesisFieldSearches(params, store, observationView),
    captures: () => materializeRetrievalFieldBundleCaptures(params, records),
    refinementReceipts: () => materializeRefinementReceipts(records)
  });
}

function createMemoryFieldSearches(
  params: RecallRetrievalFieldBundleSource,
  store: Readonly<RetrievalFieldRequestStore>,
  view: RecallRetrievalFieldObservationView
): Pick<RecallRetrievalFieldBundle, "searchMemoryKeyword" | "searchMemoryAnchor"> {
  return Object.freeze({
    searchMemoryKeyword: async (input) => selectObservationMatches(
      await store.search(memoryKeywordRequest(params, input)), view
    ),
    searchMemoryAnchor: async (input) => selectObservationMatches(
      await store.search(memoryAnchorRequest(params, input)), view
    )
  });
}

function createEvidenceFieldSearches(
  params: RecallRetrievalFieldBundleSource,
  store: Readonly<RetrievalFieldRequestStore>,
  view: RecallRetrievalFieldObservationView
): Pick<RecallRetrievalFieldBundle, "searchEvidenceKeyword" | "searchEvidenceKeywords"> {
  const request = (input: Parameters<RecallRetrievalFieldBundle["searchEvidenceKeyword"]>[0]) =>
    evidenceKeywordRequest(params, input);
  return Object.freeze({
    searchEvidenceKeyword: async (input) => selectObservationMatches(
      await store.search(request(input)), view
    ),
    searchEvidenceKeywords: async ({ queries }) => {
      const producerQueries = queries.map((query) => withRefinementDepths(params, query));
      return (await store.searchBatch({
        operation: "evidence_field_batch",
        requests: producerQueries.map(request),
        invoke: params.evidenceSearchPort?.searchManyByKeywordField === undefined
          ? undefined
          : async () => await params.evidenceSearchPort!.searchManyByKeywordField!(
            params.workspaceId, producerQueries
          )
      })).map((result) => selectObservationMatches(result, view));
    }
  });
}

function createSynthesisFieldSearches(
  params: RecallRetrievalFieldBundleSource,
  store: Readonly<RetrievalFieldRequestStore>,
  view: RecallRetrievalFieldObservationView
): Pick<RecallRetrievalFieldBundle, "searchSynthesisKeyword" | "searchSynthesisKeywords"> {
  const request = (input: Parameters<RecallRetrievalFieldBundle["searchSynthesisKeyword"]>[0]) =>
    synthesisKeywordRequest(params, input);
  return Object.freeze({
    searchSynthesisKeyword: async (input) => selectObservationMatches(
      await store.search(request(input)), view
    ),
    searchSynthesisKeywords: async ({ queries }) => {
      const producerQueries = queries.map((query) => withRefinementDepths(params, query));
      return (await store.searchBatch({
        operation: "synthesis_field_batch",
        requests: producerQueries.map(request),
        invoke: params.synthesisSearchPort?.searchManyByKeywordField === undefined
          ? undefined
          : async () => await params.synthesisSearchPort!.searchManyByKeywordField!(
            params.workspaceId, producerQueries
          )
      })).map((result) => selectObservationMatches(result, view));
    }
  });
}

function memoryKeywordRequest(
  params: RecallRetrievalFieldBundleSource,
  input: Parameters<RecallRetrievalFieldBundle["searchMemoryKeyword"]>[0]
): RetrievalFieldRequest {
  const refinementDepths = resolveRefinementDepths(params, input.limit);
  return {
    prefix: input.variant,
    source: "memory",
    objectKind: "memory_entry",
    identity: {
      ...input,
      ...(refinementDepths === undefined ? {} : {
        refinement_depths: refinementDepths
      })
    },
    operation: `${input.variant}_field`,
    maxMatches: input.limit,
    invoke: params.memoryRepo.searchByKeywordField === undefined
      ? undefined
      : async () => refinementDepths === undefined
        ? await params.memoryRepo.searchByKeywordField!(
            params.workspaceId, input.queryText, input.limit, input.scope
          )
        : await params.memoryRepo.searchByKeywordField!(
            params.workspaceId, input.queryText, input.limit, input.scope,
            refinementDepths
          )
  };
}

function memoryAnchorRequest(
  params: RecallRetrievalFieldBundleSource,
  input: Parameters<RecallRetrievalFieldBundle["searchMemoryAnchor"]>[0]
): RetrievalFieldRequest {
  const refinementDepths = resolveRefinementDepths(params, input.limit);
  return {
    prefix: "lexical_anchor",
    source: "memory",
    objectKind: "memory_entry",
    identity: {
      ...input,
      ...(refinementDepths === undefined ? {} : {
        refinement_depths: refinementDepths
      })
    },
    operation: "lexical_anchor_field",
    maxMatches: input.limit,
    invoke: params.memoryRepo.searchByAnchorField === undefined
      ? undefined
      : async () => refinementDepths === undefined
        ? await params.memoryRepo.searchByAnchorField!(
            params.workspaceId, input.anchorTokens, input.optionalTokens,
            input.limit, input.scope
          )
        : await params.memoryRepo.searchByAnchorField!(
            params.workspaceId, input.anchorTokens, input.optionalTokens,
            input.limit, input.scope, refinementDepths
          )
  };
}

function evidenceKeywordRequest(
  params: RecallRetrievalFieldBundleSource,
  input: Parameters<RecallRetrievalFieldBundle["searchEvidenceKeyword"]>[0]
): RetrievalFieldRequest {
  return keywordRequest(params, input, "evidence");
}

function synthesisKeywordRequest(
  params: RecallRetrievalFieldBundleSource,
  input: Parameters<RecallRetrievalFieldBundle["searchSynthesisKeyword"]>[0]
): RetrievalFieldRequest {
  return keywordRequest(params, input, "synthesis");
}

function keywordRequest(
  params: RecallRetrievalFieldBundleSource,
  input: Readonly<KeywordSearchBatchQuery>,
  source: "evidence" | "synthesis"
): RetrievalFieldRequest {
  const port = source === "evidence" ? params.evidenceSearchPort : params.synthesisSearchPort;
  const refinementDepths = input.refinement_depths !== undefined &&
      input.refinement_depths.length > 0
    ? input.refinement_depths
    : resolveRefinementDepths(params, input.limit);
  return {
    prefix: source === "evidence" ? "evidence_fts" : "synthesis_fts",
    source,
    objectKind: source === "evidence" ? "evidence_capsule" : "synthesis_capsule",
    identity: {
      queryText: input.queryText,
      limit: input.limit,
      ...(refinementDepths === undefined ? {} : {
        refinement_depths: refinementDepths
      })
    },
    operation: `${source}_field`,
    maxMatches: input.limit,
    invoke: port?.searchByKeywordField === undefined
      ? undefined
      : async () => refinementDepths === undefined
        ? await port.searchByKeywordField!(
            params.workspaceId, input.queryText, input.limit
          )
        : await port.searchByKeywordField!(
            params.workspaceId, input.queryText, input.limit, refinementDepths
          )
  };
}

function withRefinementDepths(
  params: RecallRetrievalFieldBundleSource,
  query: Readonly<KeywordSearchBatchQuery>
): Readonly<KeywordSearchBatchQuery> {
  const refinementDepths = resolveRefinementDepths(params, query.limit);
  const { refinement_depths: _ignored, ...base } = query;
  return Object.freeze({
    ...base,
    ...(refinementDepths === undefined ? {} : {
      refinement_depths: refinementDepths
    })
  });
}

function resolveRefinementDepths(
  params: RecallRetrievalFieldBundleSource,
  requestedDepth: number
): readonly number[] | undefined {
  const maximum = params.refinementMaxDepth;
  return maximum !== undefined && Number.isSafeInteger(maximum) && maximum > requestedDepth
    ? Object.freeze([maximum])
    : undefined;
}

function selectObservationMatches(
  result: Readonly<KeywordSearchFieldResult>,
  view: RecallRetrievalFieldObservationView
): readonly Readonly<KeywordSearchResult>[] {
  return view === "maximum"
    ? result.refinement_levels?.at(-1)?.matches ?? Object.freeze([])
    : result.matches;
}

function materializeRefinementReceipts(
  records: readonly Readonly<RecordedFieldResult>[]
): readonly Readonly<RecallRetrievalFieldRefinementReceipt>[] {
  return Object.freeze(records.flatMap((record) => {
    const receipt = createRecallRetrievalFieldRefinementReceipt({
      request_digest: record.request_digest,
      requested_depth: record.requested_depth,
      object_kind: record.object_kind,
      result: record.result
    });
    return receipt === null ? [] : [receipt];
  }));
}
