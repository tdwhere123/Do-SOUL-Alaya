import { AlayaError,
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY,
  SourceSemanticCorrespondencePreparationOptionsSchema, sourceSemanticCorrespondenceCacheMaterial,
  sourceSemanticCorrespondenceGenerationPolicies,
  sourceSemanticQueryIdentity,
  type SourceSemanticCorrespondence, type SourceSemanticCorrespondenceCoverage,
  type SourceSemanticCorrespondenceDemand,
  type SourceSemanticCorrespondenceDemandSelection, type SourceSemanticCorrespondenceGenerationPolicy,
  type SourceSemanticQuery, type SourceSemanticOutcome
} from "@do-soul/alaya-protocol";
import { MAX_SOURCE_SEMANTIC_RESPONSE_BYTES, proposeCorrespondenceSemantics } from "./source-semantic-receive.js";
import { buildSourceSemanticCorrespondenceRequest, semanticSha256, type SourceInterpretationDescriptor } from "./source-semantic-request.js";

export type SourceSemanticLibraryProduceResult =
  | Readonly<{ rawJson: string }>
  | Readonly<{ status: "no_correspondence" }>
  | Readonly<{ status: "unattempted" }>;

export type SourceSemanticLibraryProduceTask = Readonly<{
  generation_policy: SourceSemanticCorrespondenceGenerationPolicy;
  demand: SourceSemanticCorrespondenceDemand;
}>;

export type SourceSemanticLibraryPrepareStatus = "interpreted" | "no_correspondence" | "invalid" | "failed" | "preparation_failed" | "unattempted";

export type SourceSemanticLibraryPrepareOutcome = Readonly<{
  source_interpretation_id: string;
  status: SourceSemanticLibraryPrepareStatus;
  generation_policy?: SourceSemanticCorrespondenceGenerationPolicy;
  coverage?: SourceSemanticCorrespondenceCoverage;
  outcome?: SourceSemanticOutcome;
  rawJson?: string;
  raw_truncated?: boolean;
  diagnostic?: string;
}>;

export type SourceSemanticLibraryPrepareCacheEntry = Readonly<{
  rawJson: string;
  semantic_correspondence: SourceSemanticCorrespondence;
  coverage?: SourceSemanticCorrespondenceCoverage;
}>;

export type SourceSemanticLibraryPrepareInput = Readonly<{
  original_query: string;
  admitted_query_semantics: SourceSemanticQuery;
  source_interpretation_descriptors: readonly SourceInterpretationDescriptor[];
  produce: (descriptor: SourceInterpretationDescriptor, task?: SourceSemanticLibraryProduceTask) => SourceSemanticLibraryProduceResult;
  cap?: number;
  producer_id: string;
  producer_version: string;
  correspondence_demand?: SourceSemanticCorrespondenceDemandSelection;
  correspondence_cap?: number;
}>;

export type SourceSemanticLibraryPrepareResult = Readonly<{
  semantic_correspondences: readonly SourceSemanticCorrespondence[];
  outcomes: readonly SourceSemanticLibraryPrepareOutcome[];
  cache: Readonly<Record<string, SourceSemanticLibraryPrepareCacheEntry>>;
}>;

type CapturedPreparation = Readonly<{
  original_query: string;
  admitted_query_semantics: SourceSemanticQuery;
  producer_id: string;
  producer_version: string;
}>;

/** Cache key for one admitted query semantics and one source interpretation. Distinct source interpretations stay distinct. */
export function sourceSemanticLibraryCorrespondenceCacheKey(
  query_semantics_id: string,
  source_interpretation_id: string,
  generation_policy?: SourceSemanticCorrespondenceGenerationPolicy
): string {
  return sourceSemanticCorrespondenceCacheMaterial({
    query_semantics_id,
    source_interpretation_id,
    generation_policy: generation_policy ?? SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY
  });
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
  const options = SourceSemanticCorrespondencePreparationOptionsSchema.parse({
    ...(input.correspondence_demand === undefined ? {} : { correspondence_demand: input.correspondence_demand }),
    ...(input.correspondence_cap === undefined ? {} : { correspondence_cap: input.correspondence_cap })
  });
  const selection = options.correspondence_demand;
  const captured: CapturedPreparation = {
    original_query: input.original_query,
    admitted_query_semantics: structuredClone(input.admitted_query_semantics),
    producer_id: input.producer_id,
    producer_version: input.producer_version
  };
  const descriptors = input.source_interpretation_descriptors.map((row) => structuredClone(row));
  const policies = sourceSemanticCorrespondenceGenerationPolicies(captured.admitted_query_semantics, selection);
  if (selection !== undefined && policies.length === 0) {
    throw new AlayaError("VALIDATION", "query_branches correspondence_demand requires a nonempty native branch");
  }
  const cap = Math.max(0, Math.min(
    input.cap ?? SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
    SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP
  ));
  const correspondenceCap = selection === undefined ? cap : options.correspondence_cap!;
  const query_semantics_id = sourceSemanticQueryIdentity(captured.admitted_query_semantics, semanticSha256);
  const semantic_correspondences: SourceSemanticCorrespondence[] = [];
  const outcomes: SourceSemanticLibraryPrepareOutcome[] = [];
  const cache: Record<string, SourceSemanticLibraryPrepareCacheEntry> = {};
  const produce = input.produce;
  let selectedCount = 0;
  for (const [index, descriptor] of descriptors.entries()) {
    if (index >= cap) {
      outcomes.push({ source_interpretation_id: descriptor.source_interpretation_id, status: "unattempted" });
      continue;
    }
    for (const generation_policy of policies) {
      if (selectedCount >= correspondenceCap) {
        outcomes.push(scopedOutcome(descriptor.source_interpretation_id, "unattempted", selection, generation_policy));
        continue;
      }
      selectedCount += 1;
      prepareOne(produce, captured, descriptor, generation_policy, selection, query_semantics_id,
        semantic_correspondences, outcomes, cache);
    }
  }
  return { semantic_correspondences, outcomes, cache };
}

function scopedOutcome(
  source_interpretation_id: string,
  status: SourceSemanticLibraryPrepareStatus,
  selection: SourceSemanticCorrespondenceDemandSelection | undefined,
  generation_policy: SourceSemanticCorrespondenceGenerationPolicy,
  extra: Omit<SourceSemanticLibraryPrepareOutcome, "source_interpretation_id" | "status" | "generation_policy"> = {}
): SourceSemanticLibraryPrepareOutcome {
  return {
    source_interpretation_id, status, ...extra,
    ...(selection === undefined ? {} : { generation_policy })
  };
}

function prepareOne(
  produce: SourceSemanticLibraryPrepareInput["produce"],
  captured: CapturedPreparation,
  descriptor: SourceInterpretationDescriptor,
  generation_policy: SourceSemanticCorrespondenceGenerationPolicy,
  selection: SourceSemanticCorrespondenceDemandSelection | undefined,
  query_semantics_id: string,
  semantic_correspondences: SourceSemanticCorrespondence[],
  outcomes: SourceSemanticLibraryPrepareOutcome[],
  cache: Record<string, SourceSemanticLibraryPrepareCacheEntry>
): void {
  const source_interpretation_id = descriptor.source_interpretation_id;
  const policyInput = generation_policy.kind === "branch_demand" ? { generation_policy } : {};
  const proposal = {
    original_query: captured.original_query,
    admitted_query_semantics: captured.admitted_query_semantics,
    source_interpretation_descriptors: [descriptor],
    producer_id: captured.producer_id,
    producer_version: captured.producer_version,
    ...policyInput
  };
  let request: ReturnType<typeof buildSourceSemanticCorrespondenceRequest>;
  try { request = buildSourceSemanticCorrespondenceRequest(proposal); }
  catch (error) {
    outcomes.push(scopedOutcome(source_interpretation_id, "preparation_failed", selection, generation_policy, {
      diagnostic: error instanceof Error ? error.message.slice(0, 256) : "semantic_correspondence request failed"
    }));
    return;
  }
  const task = request.demand === undefined ? undefined : {
    generation_policy: request.generation_policy!, demand: request.demand
  };
  let produced: SourceSemanticLibraryProduceResult;
  try { produced = produce(structuredClone(descriptor), task === undefined ? undefined : structuredClone(task)); }
  catch (error) {
    outcomes.push(scopedOutcome(source_interpretation_id, "failed", selection, generation_policy, {
      outcome: { status: "transport_failure" },
      diagnostic: error instanceof Error ? error.message.slice(0, 256) : "producer threw"
    }));
    return;
  }
  if ("status" in produced) {
    outcomes.push(scopedOutcome(source_interpretation_id, produced.status, selection, generation_policy));
    return;
  }
  const rawJson = Buffer.from(produced.rawJson).subarray(0, MAX_SOURCE_SEMANTIC_RESPONSE_BYTES).toString("utf8");
  let received: ReturnType<typeof proposeCorrespondenceSemantics>;
  try { received = proposeCorrespondenceSemantics(proposal, { rawJson: produced.rawJson }); }
  catch (error) {
    outcomes.push(scopedOutcome(source_interpretation_id, "failed", selection, generation_policy, {
      rawJson, raw_truncated: rawJson !== produced.rawJson,
      diagnostic: error instanceof Error ? error.message.slice(0, 256) : "semantic_correspondence receiver failed"
    }));
    return;
  }
  if (received.outcome.status === "interpreted" && received.semantic_correspondence !== undefined) {
    semantic_correspondences.push(received.semantic_correspondence);
    cache[sourceSemanticLibraryCorrespondenceCacheKey(query_semantics_id, source_interpretation_id, generation_policy)] = {
      rawJson: produced.rawJson, semantic_correspondence: received.semantic_correspondence,
      ...(received.coverage === undefined ? {} : { coverage: received.coverage })
    };
    outcomes.push(scopedOutcome(source_interpretation_id, "interpreted", selection, generation_policy,
      received.coverage === undefined ? {} : { coverage: received.coverage }));
    return;
  }
  outcomes.push(scopedOutcome(source_interpretation_id,
    received.outcome.status === "invalid" ? "invalid"
      : received.outcome.status === "abstained" ? "no_correspondence" : "failed",
    selection, generation_policy,
    { outcome: received.outcome, rawJson, raw_truncated: rawJson !== produced.rawJson }));
}
