import type {
  BenchProviderResponseMetadata,
  BenchProviderUsage,
  BenchSignalExtractor
} from "../compile-seed-types.js";

export interface CachedExtractionResponseMetadata {
  readonly finish_reason: string | null;
  readonly max_output_tokens?: number;
  readonly completion_contract_version?: 1;
  readonly completion_witness?: "message" | "done_sentinel" | "finish_reason" |
    "profile_clean_eof" | "partition_composition";
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
  usage: BenchProviderUsage | undefined,
  providerBacked = false
): { readonly response_metadata?: CachedExtractionResponseMetadata } {
  if (providerBacked) assertProviderCompletionAuthority(response);
  if (response === undefined && usage === undefined) return {};
  return {
    response_metadata: {
      finish_reason: response?.finishReason ?? null,
      ...(response?.maxOutputTokens === undefined ? {} : {
        max_output_tokens: response.maxOutputTokens
      }),
      ...(response?.completionContractVersion === undefined || response.completionWitness === undefined ? {} : {
        completion_contract_version: response.completionContractVersion,
        completion_witness: response.completionWitness
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
  value: CachedExtractionResponseMetadata | undefined,
  providerBacked = false
): {
  readonly responseMetadata?: BenchProviderResponseMetadata;
  readonly usage?: BenchProviderUsage;
} {
  if (value === undefined) {
    if (providerBacked) throw new Error("provider-backed response_metadata is required");
    return {};
  }
  if (typeof value !== "object" || value === null ||
      (value.finish_reason !== null && typeof value.finish_reason !== "string") ||
      (value.max_output_tokens !== undefined && !isPositiveInteger(value.max_output_tokens)) ||
      !isCompletionMetadataValid(value)) {
    throw new Error("response_metadata is invalid");
  }
  if (value.finish_reason === "length") {
    throw new Error("response_metadata finish_reason=length is not a complete extraction");
  }
  const responseMetadata = toBenchProviderResponseMetadata(value);
  if (providerBacked) assertProviderCompletionAuthority(responseMetadata);
  if (value.finish_reason === null && value.completion_contract_version !== 1) {
    throw new Error("response_metadata null finish_reason lacks completion authority");
  }
  const usage = inspectCachedUsage(value.usage);
  return {
    responseMetadata,
    ...(usage === undefined ? {} : { usage })
  };
}

function toBenchProviderResponseMetadata(
  value: CachedExtractionResponseMetadata
): BenchProviderResponseMetadata {
  return {
    finishReason: value.finish_reason,
    ...(value.max_output_tokens === undefined ? {} : {
      maxOutputTokens: value.max_output_tokens
    }),
    ...(value.completion_contract_version === undefined ||
      value.completion_witness === undefined ? {} : {
        completionContractVersion: value.completion_contract_version,
        completionWitness: value.completion_witness
      })
  };
}

function assertProviderCompletionAuthority(
  response: BenchProviderResponseMetadata | undefined
): void {
  if (response?.completionContractVersion !== 1 ||
      response.completionWitness === undefined) {
    throw new Error("provider-backed response_metadata lacks versioned completion authority");
  }
}

function isCompletionMetadataValid(value: CachedExtractionResponseMetadata): boolean {
  if (value.completion_contract_version === undefined) {
    return value.completion_witness === undefined;
  }
  return value.completion_contract_version === 1 &&
    (value.completion_witness === "message" ||
      value.completion_witness === "done_sentinel" ||
      value.completion_witness === "finish_reason" ||
      value.completion_witness === "profile_clean_eof" ||
      value.completion_witness === "partition_composition");
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
