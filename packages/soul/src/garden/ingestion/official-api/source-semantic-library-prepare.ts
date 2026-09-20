import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, sourceSemanticQueryIdentity,
  type SourceSemanticAlignment, type SourceSemanticQuery, type SourceSemanticOutcome
} from "@do-soul/alaya-protocol";
import { MAX_SOURCE_SEMANTIC_RESPONSE_BYTES, proposeAlignmentSemantics } from "./source-semantic-receive.js";
import { semanticSha256, type SourceSemanticHDescriptor } from "./source-semantic-request.js";

export type SourceSemanticLibraryProduceResult =
  | Readonly<{ rawJson: string }>
  | Readonly<{ status: "no_alignment" }>
  | Readonly<{ status: "unattempted" }>;

export type SourceSemanticLibraryPrepareStatus = "interpreted" | "no_alignment" | "invalid" | "failed" | "unattempted";

export type SourceSemanticLibraryPrepareOutcome = Readonly<{
  h_id: string;
  status: SourceSemanticLibraryPrepareStatus;
  outcome?: SourceSemanticOutcome;
  rawJson?: string;
  raw_truncated?: boolean;
  diagnostic?: string;
}>;

export type SourceSemanticLibraryPrepareCacheEntry = Readonly<{
  rawJson: string;
  alignment: SourceSemanticAlignment;
}>;

export type SourceSemanticLibraryPrepareInput = Readonly<{
  original_query: string;
  admitted_q: SourceSemanticQuery;
  h_descriptors: readonly SourceSemanticHDescriptor[];
  produce: (descriptor: SourceSemanticHDescriptor) => SourceSemanticLibraryProduceResult;
  cap?: number;
  producer_id: string;
  producer_version: string;
}>;

export type SourceSemanticLibraryPrepareResult = Readonly<{
  alignments: readonly SourceSemanticAlignment[];
  outcomes: readonly SourceSemanticLibraryPrepareOutcome[];
  cache: Readonly<Record<string, SourceSemanticLibraryPrepareCacheEntry>>;
}>;

/** Cache key for one admitted Q and one H. Distinct H stay distinct. */
export function sourceSemanticLibraryAlignmentCacheKey(q_id: string, h_id: string): string {
  return `${q_id}:${h_id}`;
}

/** Provider-free bounded A preparation. The caller supplies `produce`; this module never dispatches a provider. */
export function prepareSourceSemanticLibrary(
  input: SourceSemanticLibraryPrepareInput
): SourceSemanticLibraryPrepareResult {
  if (input.cap !== undefined && (!Number.isSafeInteger(input.cap) || input.cap < 0)) {
    throw new Error("alignment preparation cap must be a nonnegative safe integer");
  }
  if (input.admitted_q.original_query_digest !== `sha256:${semanticSha256(input.original_query)}`) {
    throw new Error("alignment preparation Q does not bind the original query");
  }
  const cap = Math.max(0, Math.min(
    input.cap ?? SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
    SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP
  ));
  const q_id = sourceSemanticQueryIdentity(input.admitted_q, semanticSha256);
  const alignments: SourceSemanticAlignment[] = [];
  const outcomes: SourceSemanticLibraryPrepareOutcome[] = [];
  const cache: Record<string, SourceSemanticLibraryPrepareCacheEntry> = {};
  for (const [index, descriptor] of input.h_descriptors.entries()) {
    if (index >= cap) {
      outcomes.push({ h_id: descriptor.h_id, status: "unattempted" });
      continue;
    }
    let produced: SourceSemanticLibraryProduceResult;
    try { produced = input.produce(descriptor); }
    catch (error) {
      outcomes.push({ h_id: descriptor.h_id, status: "failed", outcome: { status: "transport_failure" },
        diagnostic: error instanceof Error ? error.message.slice(0, 256) : "producer threw" });
      continue;
    }
    if ("status" in produced) {
      outcomes.push({ h_id: descriptor.h_id, status: produced.status });
      continue;
    }
    let received: ReturnType<typeof proposeAlignmentSemantics>;
    const rawJson = Buffer.from(produced.rawJson).subarray(0, MAX_SOURCE_SEMANTIC_RESPONSE_BYTES).toString("utf8");
    try { received = proposeAlignmentSemantics({
      admitted_q: input.admitted_q,
      h_descriptors: [descriptor],
      producer_id: input.producer_id,
      producer_version: input.producer_version
    }, { rawJson: produced.rawJson }); }
    catch (error) {
      outcomes.push({ h_id: descriptor.h_id, status: "failed", rawJson, raw_truncated: rawJson !== produced.rawJson,
        diagnostic: error instanceof Error ? error.message.slice(0, 256) : "alignment receiver failed" });
      continue;
    }
    if (received.outcome.status === "interpreted" && received.alignment !== undefined) {
      alignments.push(received.alignment);
      cache[sourceSemanticLibraryAlignmentCacheKey(q_id, descriptor.h_id)] = {
        rawJson: produced.rawJson, alignment: received.alignment
      };
      outcomes.push({ h_id: descriptor.h_id, status: "interpreted" });
      continue;
    }
    outcomes.push({
      h_id: descriptor.h_id,
      status: received.outcome.status === "invalid" ? "invalid"
        : received.outcome.status === "abstained" ? "no_alignment" : "failed",
      outcome: received.outcome, rawJson, raw_truncated: rawJson !== produced.rawJson
    });
  }
  return { alignments, outcomes, cache };
}
