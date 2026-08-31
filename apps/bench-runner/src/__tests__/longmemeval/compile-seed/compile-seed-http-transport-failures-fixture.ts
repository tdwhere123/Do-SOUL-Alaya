import { createGardenHttpExtractor } from "../../../runs/compile-seed.js";
import type {
  BenchTransportFailureAttempt,
  CompileSeedExtractionConfig
} from "../../../runs/compile-seed/compile-seed-types.js";

export const HTTP_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://provider.invalid/v1",
  model: "deepseek-test",
  requestProfile: "provider-default-v1",
  apiKey: "secret-key"
};

export async function captureTerminalFailure(
  fetchImpl: typeof fetch,
  input: { readonly timeoutMs?: number; readonly abortSignal?: AbortSignal } = {}
): Promise<unknown> {
  const extractor = createGardenHttpExtractor(HTTP_CONFIG, { fetch: fetchImpl });
  return captureExtractorFailure(extractor, { ...input, retryMode: "disabled" });
}

export async function captureExtractorFailure(
  extractor: ReturnType<typeof createGardenHttpExtractor>,
  input: {
    readonly timeoutMs?: number;
    readonly abortSignal?: AbortSignal;
    readonly retryMode?: "default" | "disabled";
    readonly onTransportAttempt?: () => void | Promise<void>;
  } = {}
): Promise<unknown> {
  try {
    await extractor.extract({ systemPrompt: "s", userPrompt: "u", ...input });
  } catch (error) {
    return error;
  }
  throw new Error("expected extractor failure");
}

export function readBenchRetry(error: unknown): unknown {
  return (error as { readonly benchRetry?: unknown }).benchRetry;
}

export function readTransportFailures(
  error: unknown
): readonly BenchTransportFailureAttempt[] {
  const benchRetry = readBenchRetry(error) as {
    readonly transportFailures?: readonly BenchTransportFailureAttempt[];
  } | undefined;
  return benchRetry?.transportFailures ?? [];
}
