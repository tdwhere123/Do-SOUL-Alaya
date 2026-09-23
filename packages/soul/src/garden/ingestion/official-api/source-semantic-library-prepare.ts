import { AlayaError,

  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, sourceSemanticQueryIdentity,
  type SourceSemanticCorrespondence, type SourceSemanticQuery, type SourceSemanticOutcome
} from "@do-soul/alaya-protocol";
import { MAX_SOURCE_SEMANTIC_RESPONSE_BYTES, proposeCorrespondenceSemantics } from "./source-semantic-receive.js";
import { semanticSha256, type SourceInterpretationDescriptor } from "./source-semantic-request.js";

export type SourceSemanticLibraryProduceResult =
  | Readonly<{ rawJson: string }>
  | Readonly<{ status: "no_correspondence" }>
  | Readonly<{ status: "unattempted" }>;

export type SourceSemanticLibraryPrepareStatus = "interpreted" | "no_correspondence" | "invalid" | "failed" | "unattempted";

export type SourceSemanticLibraryPrepareOutcome = Readonly<{
  source_interpretation_id: string;
  status: SourceSemanticLibraryPrepareStatus;
  outcome?: SourceSemanticOutcome;
  rawJson?: string;
  raw_truncated?: boolean;
  diagnostic?: string;
}>;

export type SourceSemanticLibraryPrepareCacheEntry = Readonly<{
  rawJson: string;
  semantic_correspondence: SourceSemanticCorrespondence;
}>;

export type SourceSemanticLibraryPrepareInput = Readonly<{
  original_query: string;
  admitted_query_semantics: SourceSemanticQuery;
  source_interpretation_descriptors: readonly SourceInterpretationDescriptor[];
  produce: (descriptor: SourceInterpretationDescriptor) => SourceSemanticLibraryProduceResult;
  cap?: number;
  producer_id: string;
  producer_version: string;
}>;

export type SourceSemanticLibraryPrepareResult = Readonly<{
  semantic_correspondences: readonly SourceSemanticCorrespondence[];
  outcomes: readonly SourceSemanticLibraryPrepareOutcome[];
  cache: Readonly<Record<string, SourceSemanticLibraryPrepareCacheEntry>>;
}>;

/** Cache key for one admitted query semantics and one source interpretation. Distinct source interpretations stay distinct. */
export function sourceSemanticLibraryCorrespondenceCacheKey(query_semantics_id: string, source_interpretation_id: string): string {
  return `${query_semantics_id}:${source_interpretation_id}`;
}

/** Provider-free bounded semantic-correspondence preparation. The caller supplies `produce`; this module never dispatches a provider. */
export function prepareSourceSemanticLibrary(
  input: SourceSemanticLibraryPrepareInput
): SourceSemanticLibraryPrepareResult {
  if (input.cap !== undefined && (!Number.isSafeInteger(input.cap) || input.cap < 0)) {
    throw new AlayaError("VALIDATION", "semantic_correspondence preparation cap must be a nonnegative safe integer");
  }
  if (input.admitted_query_semantics.original_query_digest !== `sha256:${semanticSha256(input.original_query)}`) {
    throw new AlayaError("CONFLICT", "semantic_correspondence preparation does not bind the original query");
  }
  const cap = Math.max(0, Math.min(
    input.cap ?? SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
    SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP
  ));
  const query_semantics_id = sourceSemanticQueryIdentity(input.admitted_query_semantics, semanticSha256);
  const semantic_correspondences: SourceSemanticCorrespondence[] = [];
  const outcomes: SourceSemanticLibraryPrepareOutcome[] = [];
  const cache: Record<string, SourceSemanticLibraryPrepareCacheEntry> = {};
  for (const [index, descriptor] of input.source_interpretation_descriptors.entries()) {
    if (index >= cap) {
      outcomes.push({ source_interpretation_id: descriptor.source_interpretation_id, status: "unattempted" });
      continue;
    }
    let produced: SourceSemanticLibraryProduceResult;
    try { produced = input.produce(descriptor); }
    catch (error) {
      outcomes.push({ source_interpretation_id: descriptor.source_interpretation_id, status: "failed", outcome: { status: "transport_failure" },
        diagnostic: error instanceof Error ? error.message.slice(0, 256) : "producer threw" });
      continue;
    }
    if ("status" in produced) {
      outcomes.push({ source_interpretation_id: descriptor.source_interpretation_id, status: produced.status });
      continue;
    }
    let received: ReturnType<typeof proposeCorrespondenceSemantics>;
    const rawJson = Buffer.from(produced.rawJson).subarray(0, MAX_SOURCE_SEMANTIC_RESPONSE_BYTES).toString("utf8");
    try { received = proposeCorrespondenceSemantics({
      original_query: input.original_query,
      admitted_query_semantics: input.admitted_query_semantics,
      source_interpretation_descriptors: [descriptor],
      producer_id: input.producer_id,
      producer_version: input.producer_version
    }, { rawJson: produced.rawJson }); }
    catch (error) {
      outcomes.push({ source_interpretation_id: descriptor.source_interpretation_id, status: "failed", rawJson, raw_truncated: rawJson !== produced.rawJson,
        diagnostic: error instanceof Error ? error.message.slice(0, 256) : "semantic_correspondence receiver failed" });
      continue;
    }
    if (received.outcome.status === "interpreted" && received.semantic_correspondence !== undefined) {
      semantic_correspondences.push(received.semantic_correspondence);
      cache[sourceSemanticLibraryCorrespondenceCacheKey(query_semantics_id, descriptor.source_interpretation_id)] = {
        rawJson: produced.rawJson, semantic_correspondence: received.semantic_correspondence
      };
      outcomes.push({ source_interpretation_id: descriptor.source_interpretation_id, status: "interpreted" });
      continue;
    }
    outcomes.push({
      source_interpretation_id: descriptor.source_interpretation_id,
      status: received.outcome.status === "invalid" ? "invalid"
        : received.outcome.status === "abstained" ? "no_correspondence" : "failed",
      outcome: received.outcome, rawJson, raw_truncated: rawJson !== produced.rawJson
    });
  }
  return { semantic_correspondences, outcomes, cache };
}
