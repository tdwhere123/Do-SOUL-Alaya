import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_OCCUPANCY,
  SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  SoulMemorySearchResponseSchema, type Continuation, type InformationIndex, type MemorySearchResult,
  type SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResults, SOURCE_SEMANTIC_LIBRARY_ORDER } from "@do-soul/alaya-core";
import { FirstExposureSession, type FirstExposurePage } from "./first-exposure-session.js";

/** Shared native/benchmark configuration. Zero provider calls on this path. */
export const SOURCE_SEMANTIC_LIBRARY_RECALL = Object.freeze({
  operation: "recall" as const,
  enumeration_policy: SOURCE_SEMANTIC_LIBRARY_ORDER.enumeration_policy,
  occupancy: SOURCE_SEMANTIC_LIBRARY_OCCUPANCY,
  occupancy_prefix: SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX,
  page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  scoring_k: 5,
  examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
  source_interpretation_page_size: 16,
  result_kind_view: "mixed" as const,
  provider_calls: 0
});

export function soulSearchFromLibraryRecall(result: Readonly<{
  delivery_id?: string; index?: InformationIndex; results?: readonly MemorySearchResult[];
  total_count?: number; previews?: Readonly<Record<string, string>>;
}>): SoulMemorySearchResponse {
  if (result.delivery_id === undefined || result.index === undefined) throw new Error("library recall has no delivered page");
  const results = result.results ?? encodeSourceSemanticLibraryResults(
    result.index, new Map(Object.entries(result.previews ?? {}))
  );
  return SoulMemorySearchResponseSchema.parse({
    delivery_id: result.delivery_id, protocol_version: 1, results,
    total_count: result.total_count ?? results.length,
    index: result.index, page_purpose: result.index.page_purpose, order_status: result.index.order_status
  });
}

/** Existing first-exposure owner. Continuation cannot establish a new initial page. */
export function recordSourceSemanticLibraryFirstExposure(
  result: Parameters<typeof soulSearchFromLibraryRecall>[0],
  session = new FirstExposureSession(),
  continuation?: Continuation | null
): FirstExposurePage {
  return session.record(soulSearchFromLibraryRecall(result), continuation);
}
