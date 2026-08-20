import {
  parseOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  isBenchTerminalRetryClassification,
  type BenchProviderUsage,
  type BenchSignalExtractor,
  type BenchTerminalRetryClassification,
  type BenchTransportFailureAttempt
} from "../compile-seed-types.js";
import {
  isOutputTokenTruncation,
  markOutputTokenTruncation
} from "./output-token-retry.js";

type ExtractInput = Parameters<BenchSignalExtractor["extract"]>[0];
type ExtractResult = Awaited<ReturnType<BenchSignalExtractor["extract"]>>;

interface TransportSummary {
  readonly failures: readonly BenchTransportFailureAttempt[];
  readonly successfulRequestCount: number;
  readonly usageRequestCount: number;
  readonly rateLimitRetries: number;
  readonly usage?: BenchProviderUsage;
}

interface FailureSummary extends TransportSummary {
  readonly classification?: BenchTerminalRetryClassification;
  readonly postComposeFailure: boolean;
}

interface TerminalSummary extends FailureSummary {
  readonly classification: BenchTerminalRetryClassification;
}

export async function extractGardenHttpWithAssertionPartition(
  input: ExtractInput,
  runRequest: (request: ExtractInput, allowOutputTokenEscalation: boolean) => Promise<ExtractResult>
): Promise<ExtractResult> {
  const request = readPartitionableRequest(input);
  try {
    return await runRequest(input, request === null);
  } catch (cause) {
    if (request === null || !isOutputTokenTruncation(cause)) throw cause;
    return extractPartitions(input, request, cause, runRequest);
  }
}

async function extractPartitions(
  input: ExtractInput,
  request: OfficialApiExtractionRequest,
  parentFailure: unknown,
  runRequest: (request: ExtractInput, allowOutputTokenEscalation: boolean) => Promise<ExtractResult>
): Promise<ExtractResult> {
  const results: ExtractResult[] = [];
  for (const partition of splitRequest(request)) {
    try {
      results.push(await extractGardenHttpWithAssertionPartition(
        withPartitionValidation(input, partition),
        runRequest
      ));
    } catch (cause) {
      throw buildPartitionFailure(parentFailure, results, cause);
    }
  }
  return buildPartitionSuccess(input, request, parentFailure, results);
}

function withPartitionValidation(
  input: ExtractInput,
  request: OfficialApiExtractionRequest
): ExtractInput {
  const allowedIds = new Set(request.source_assertions.map(({ assertion_id }) => assertion_id));
  return {
    ...input,
    userPrompt: stringifyOfficialApiExtractionRequest(request),
    validateRawJson: (rawJson) => {
      assertPartitionLocators(rawJson, allowedIds);
      input.validateRawJson?.(rawJson);
    }
  };
}

function assertPartitionLocators(rawJson: string, allowedIds: ReadonlySet<number>): void {
  const parsed = JSON.parse(rawJson) as { readonly signals?: unknown };
  if (!Array.isArray(parsed.signals)) {
    throw new Error("official API signals array missing from assertion partition response");
  }
  for (const signal of parsed.signals) {
    const assertionId = readSignalAssertionId(signal);
    if (!allowedIds.has(assertionId)) {
      throw new Error("official API signal locator is outside its assertion partition");
    }
  }
}

function readSignalAssertionId(signal: unknown): number {
  if (typeof signal !== "object" || signal === null) {
    throw new Error("official API partition signal requires a source locator");
  }
  const locator = (signal as { readonly source_locator?: unknown }).source_locator;
  if (typeof locator !== "object" || locator === null) {
    throw new Error("official API partition signal requires a source locator");
  }
  const assertionId = (locator as { readonly assertion_id?: unknown }).assertion_id;
  if (!Number.isSafeInteger(assertionId) || Number(assertionId) < 1) {
    throw new Error("official API partition signal locator is invalid");
  }
  return Number(assertionId);
}

function readPartitionableRequest(input: ExtractInput): OfficialApiExtractionRequest | null {
  if (input.retryMode === "disabled") return null;
  try {
    const request = parseOfficialApiExtractionRequest(JSON.parse(input.userPrompt));
    return request.source_assertions.length > 1 ? request : null;
  } catch {
    return null;
  }
}

function splitRequest(
  request: OfficialApiExtractionRequest
): readonly [OfficialApiExtractionRequest, OfficialApiExtractionRequest] {
  const midpoint = Math.ceil(request.source_assertions.length / 2);
  return [
    parseOfficialApiExtractionRequest({
      ...request,
      source_assertions: request.source_assertions.slice(0, midpoint)
    }),
    parseOfficialApiExtractionRequest({
      ...request,
      source_assertions: request.source_assertions.slice(midpoint)
    })
  ];
}

function buildPartitionSuccess(
  input: ExtractInput,
  request: OfficialApiExtractionRequest,
  parentFailure: unknown,
  results: readonly ExtractResult[]
): ExtractResult {
  const aggregate = aggregateTransport([
    readTerminalSummary(parentFailure),
    ...results.map(readSuccessSummary)
  ]);
  let rawJson: string;
  try {
    rawJson = JSON.stringify({ signals: orderedPartitionSignals(request, results) });
    input.validateRawJson?.(rawJson);
  } catch (cause) {
    throw buildPostComposeFailure(aggregate, cause);
  }
  return {
    rawJson,
    ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage }),
    responseMetadata: partitionCompletionMetadata(results),
    extractorMeta: {
      recoveryKind: "none",
      retryCount: aggregate.failures.length,
      retryClassification: "success_after_retry",
      rateLimitRetries: aggregate.rateLimitRetries,
      successfulRequestCount: aggregate.successfulRequestCount,
      usageRequestCount: aggregate.usageRequestCount,
      transportFailures: aggregate.failures
    }
  };
}

function partitionCompletionMetadata(
  results: readonly ExtractResult[]
): NonNullable<ExtractResult["responseMetadata"]> {
  if (results.length === 0 || results.some((result) =>
    result.responseMetadata?.completionContractVersion !== 1 ||
    result.responseMetadata.completionWitness === undefined)) {
    throw new Error("partition composition lacks child completion authority");
  }
  return {
    finishReason: null,
    completionContractVersion: 1,
    completionWitness: "partition_composition"
  };
}

function buildPartitionFailure(
  parentFailure: unknown,
  completed: readonly ExtractResult[],
  childFailure: unknown
): Error {
  const child = readFailureSummary(childFailure);
  const aggregate = aggregateTransport([
    readTerminalSummary(parentFailure),
    ...completed.map(readSuccessSummary),
    child
  ]);
  const wrapped = new Error(
    childFailure instanceof Error ? childFailure.message : "partitioned garden extraction failed",
    { cause: childFailure }
  );
  (wrapped as { benchRetry?: unknown }).benchRetry = {
    retryCount: Math.max(
      0,
      aggregate.failures.length - (child.classification === undefined ? 0 : 1)
    ),
    ...(child.classification === undefined
      ? { postComposeFailure: true as const }
      : { retryClassification: child.classification }),
    rateLimitRetries: aggregate.rateLimitRetries,
    successfulRequestCount: aggregate.successfulRequestCount,
    usageRequestCount: aggregate.usageRequestCount,
    transportFailures: aggregate.failures,
    ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage })
  };
  return isOutputTokenTruncation(childFailure)
    ? markOutputTokenTruncation(wrapped)
    : wrapped;
}

function readSuccessSummary(result: ExtractResult): TransportSummary {
  const failures = result.extractorMeta?.transportFailures ?? [];
  const successfulRequestCount = result.extractorMeta?.successfulRequestCount ?? 1;
  return {
    failures,
    successfulRequestCount,
    usageRequestCount: result.extractorMeta?.usageRequestCount ??
      (result.usage === undefined ? 0 : 1),
    rateLimitRetries: result.extractorMeta?.rateLimitRetries ?? 0,
    ...(result.usage === undefined ? {} : { usage: result.usage })
  };
}

function readTerminalSummary(cause: unknown): TerminalSummary {
  const summary = readFailureSummary(cause);
  if (summary.classification === undefined) throw cause;
  return { ...summary, classification: summary.classification };
}

function readFailureSummary(cause: unknown): FailureSummary {
  if (typeof cause !== "object" || cause === null) throw cause;
  const value = (cause as { readonly benchRetry?: unknown }).benchRetry;
  if (!isFailureMeta(value)) throw cause;
  return {
    failures: value.transportFailures,
    successfulRequestCount: value.successfulRequestCount ?? 0,
    usageRequestCount: value.usageRequestCount ?? (value.usage === undefined ? 0 : 1),
    rateLimitRetries: value.rateLimitRetries,
    ...(value.retryClassification === undefined
      ? {}
      : { classification: value.retryClassification }),
    postComposeFailure: value.postComposeFailure === true,
    ...(value.usage === undefined ? {} : { usage: value.usage })
  };
}

function buildPostComposeFailure(aggregate: TransportSummary, cause: unknown): Error {
  const wrapped = new Error(
    cause instanceof Error ? cause.message : "partitioned extraction composition failed",
    { cause }
  );
  (wrapped as { benchRetry?: unknown }).benchRetry = {
    retryCount: aggregate.failures.length,
    rateLimitRetries: aggregate.rateLimitRetries,
    successfulRequestCount: aggregate.successfulRequestCount,
    usageRequestCount: aggregate.usageRequestCount,
    transportFailures: aggregate.failures,
    postComposeFailure: true,
    ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage })
  };
  return wrapped;
}

function aggregateTransport(summaries: readonly TransportSummary[]): TransportSummary {
  const failures: BenchTransportFailureAttempt[] = [];
  let requestOffset = 0;
  let successfulRequestCount = 0;
  let usageRequestCount = 0;
  let rateLimitRetries = 0;
  let usage: BenchProviderUsage | undefined;
  for (const summary of summaries) {
    failures.push(...summary.failures.map((failure) => ({
      ...failure,
      attempt: failure.attempt + requestOffset
    })));
    requestOffset += summary.failures.length + summary.successfulRequestCount;
    successfulRequestCount += summary.successfulRequestCount;
    usageRequestCount += summary.usageRequestCount;
    rateLimitRetries += summary.rateLimitRetries;
    usage = addUsage(usage, summary.usage);
  }
  return {
    failures: Object.freeze(failures),
    successfulRequestCount,
    usageRequestCount,
    rateLimitRetries,
    ...(usage === undefined ? {} : { usage })
  };
}

function readSignals(rawJson: string): readonly unknown[] {
  const parsed = JSON.parse(rawJson) as { readonly signals?: unknown };
  if (!Array.isArray(parsed.signals)) throw new TypeError("partition response is not a signals envelope");
  return parsed.signals;
}

function orderedPartitionSignals(
  request: OfficialApiExtractionRequest,
  results: readonly ExtractResult[]
): readonly unknown[] {
  const order = new Map(request.source_assertions.map(
    ({ assertion_id }, index) => [assertion_id, index] as const
  ));
  return results
    .flatMap(({ rawJson }) => readSignals(rawJson))
    .map((signal, providerOrder) => ({
      signal,
      providerOrder,
      assertionOrder: order.get(readSignalAssertionId(signal))
    }))
    .sort((left, right) => {
      if (left.assertionOrder === undefined || right.assertionOrder === undefined) {
        throw new Error("official API signal locator is outside its source catalog");
      }
      return left.assertionOrder - right.assertionOrder || left.providerOrder - right.providerOrder;
    })
    .map(({ signal }) => signal);
}

function addUsage(
  left: BenchProviderUsage | undefined,
  right: BenchProviderUsage | undefined
): BenchProviderUsage | undefined {
  if (right === undefined) return left;
  return {
    inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
    outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
    totalTokens: (left?.totalTokens ?? 0) + right.totalTokens
  };
}

function isFailureMeta(value: unknown): value is {
  readonly retryClassification?: BenchTerminalRetryClassification;
  readonly postComposeFailure?: true;
  readonly rateLimitRetries: number;
  readonly transportFailures: readonly BenchTransportFailureAttempt[];
  readonly successfulRequestCount?: number;
  readonly usageRequestCount?: number;
  readonly usage?: BenchProviderUsage;
} {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as {
    readonly retryClassification?: unknown;
    readonly rateLimitRetries?: unknown;
    readonly transportFailures?: unknown;
    readonly postComposeFailure?: unknown;
  };
  const terminal = isBenchTerminalRetryClassification(meta.retryClassification);
  const postCompose = meta.postComposeFailure === true;
  return terminal !== postCompose &&
    Number.isSafeInteger(meta.rateLimitRetries) && Number(meta.rateLimitRetries) >= 0 &&
    Array.isArray(meta.transportFailures);
}
