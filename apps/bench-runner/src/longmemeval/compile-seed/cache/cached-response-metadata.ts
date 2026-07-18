import type {
  BenchProviderResponseMetadata,
  BenchProviderUsage,
  BenchSignalExtractor
} from "../compile-seed-types.js";

export interface CachedExtractionResponseMetadata {
  readonly finish_reason: string | null;
  readonly max_output_tokens?: number;
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  };
}

export function cachedExtractionResult(cached: {
  readonly rawJson: string;
  readonly responseMetadata?: BenchProviderResponseMetadata;
  readonly usage?: BenchProviderUsage;
}): Awaited<ReturnType<BenchSignalExtractor["extract"]>> {
  return {
    rawJson: cached.rawJson,
    ...(cached.responseMetadata === undefined ? {} : {
      responseMetadata: cached.responseMetadata
    }),
    ...(cached.usage === undefined ? {} : { usage: cached.usage })
  };
}

export function persistedResponseMetadata(
  response: BenchProviderResponseMetadata | undefined,
  usage: BenchProviderUsage | undefined
): { readonly response_metadata?: CachedExtractionResponseMetadata } {
  if (response === undefined && usage === undefined) return {};
  return {
    response_metadata: {
      finish_reason: response?.finishReason ?? null,
      ...(response?.maxOutputTokens === undefined ? {} : {
        max_output_tokens: response.maxOutputTokens
      }),
      ...(usage === undefined ? {} : { usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens
      } })
    }
  };
}

export function inspectCachedResponseMetadata(
  value: CachedExtractionResponseMetadata | undefined
): {
  readonly responseMetadata?: BenchProviderResponseMetadata;
  readonly usage?: BenchProviderUsage;
} {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null ||
      (value.finish_reason !== null && typeof value.finish_reason !== "string") ||
      (value.max_output_tokens !== undefined && !isPositiveInteger(value.max_output_tokens))) {
    throw new Error("response_metadata is invalid");
  }
  if (value.finish_reason === "length") {
    throw new Error("response_metadata finish_reason=length is not a complete extraction");
  }
  const usage = inspectCachedUsage(value.usage);
  return {
    responseMetadata: {
      finishReason: value.finish_reason,
      ...(value.max_output_tokens === undefined ? {} : {
        maxOutputTokens: value.max_output_tokens
      })
    },
    ...(usage === undefined ? {} : { usage })
  };
}

function inspectCachedUsage(
  value: CachedExtractionResponseMetadata["usage"]
): BenchProviderUsage | undefined {
  if (value === undefined) return undefined;
  if (!isNonNegativeInteger(value.input_tokens) ||
      !isNonNegativeInteger(value.output_tokens) ||
      !isNonNegativeInteger(value.total_tokens)) {
    throw new Error("response_metadata usage is invalid");
  }
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens
  };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
