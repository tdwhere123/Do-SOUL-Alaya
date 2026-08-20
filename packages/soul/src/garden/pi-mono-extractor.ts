import { SignalExtractorError } from "./pi-mono-errors.js";
import { parseOrRecoverJson, type JsonRecoveryKind } from "./pi-mono-json-recovery.js";
import { readTextContent, requestJsonPayload, selectModel } from "./pi-mono-transport.js";

export { SignalExtractorError } from "./pi-mono-errors.js";
export type { SignalExtractorErrorKind } from "./pi-mono-errors.js";
export type { JsonRecoveryKind } from "./pi-mono-json-recovery.js";

export interface SignalExtractor {
  extract(input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly abortSignal?: AbortSignal;
    readonly timeoutMs?: number;
    /** Lets a caller reject semantically unusable JSON at the consumer boundary. */
    readonly validateRawJson?: (rawJson: string) => void;
    /** Caller-owned correction when its response schema is not a signals envelope. */
    readonly responseSchemaRetryInstruction?: string;
  }): Promise<{ readonly rawJson: string; readonly extractorMeta?: SignalExtractorMeta }>;
}

// invariant: per-extract-call observability surface for the diagnostic dump
// and the bench seed report. recoveryKind records which tryRecoverJson branch
// (markdown / trailing / balanced) salvaged the body, or "none" when the
// model returned strict JSON. Retry fields are an opaque execution receipt
// from the injected transport; Soul never derives provider retry policy.
export interface SignalExtractorMeta {
  readonly recoveryKind: JsonRecoveryKind;
  readonly retryCount: number;
  readonly retryClassification: string;
}

export interface PiMonoExtractorDependencies {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly complete?: PiMonoComplete;
  readonly getModel?: PiMonoGetModel;
}

// Local seam types for the LLM transport. Shape is preserved (model handle +
// context + options -> assistant message) so injected test transports keep
// working; the production default is fetch-based.
export interface PiMonoModel {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly string[];
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface PiMonoContext {
  readonly systemPrompt: string;
  readonly messages: readonly {
    readonly role: string;
    readonly content: string;
    readonly timestamp: number;
  }[];
}

export interface PiMonoStreamOptions {
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly temperature?: number;
  readonly onPayload?: (payload: unknown, model: PiMonoModel) => unknown;
}

export interface PiMonoAssistantMessage {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  /** Transport-neutral execution receipt supplied by the injected completion port. */
  readonly executionMeta?: {
    readonly retryCount: number;
    readonly retryClassification: string;
  };
}

export type PiMonoComplete = (
  model: PiMonoModel,
  context: PiMonoContext,
  options?: PiMonoStreamOptions
) => Promise<PiMonoAssistantMessage>;

export type PiMonoGetModel = (provider: "openai", modelId: string) => PiMonoModel | undefined;

const DEFAULT_MAX_RETRIES = 0;
export function createPiMonoExtractor(deps: PiMonoExtractorDependencies): SignalExtractor {
  const runtime = createExtractorRuntime(deps);
  return {
    extract: async (input) => runExtraction(runtime, input)
  };
}

interface ExtractorRuntime {
  readonly apiKey: string;
  readonly complete: PiMonoComplete;
  readonly model: PiMonoModel;
}

type ExtractInput = Parameters<SignalExtractor["extract"]>[0];

function createExtractorRuntime(
  deps: PiMonoExtractorDependencies
): ExtractorRuntime {
  if (deps.complete === undefined) {
    throw new TypeError("createPiMonoExtractor requires an injected complete transport");
  }
  const completeImpl = deps.complete;
  // The default carries no provider catalog; selectModel falls through to the
  // OpenAI-compatible handle that pins the resolved baseUrl.
  const getModelImpl = deps.getModel ?? (() => undefined);
  return {
    apiKey: deps.apiKey,
    complete: completeImpl,
    model: selectModel({
      modelId: deps.model,
      endpoint: deps.endpoint,
      getModel: getModelImpl
    })
  };
}

async function runExtraction(
  runtime: ExtractorRuntime,
  input: ExtractInput
): Promise<{ readonly rawJson: string; readonly extractorMeta?: SignalExtractorMeta }> {
  try {
    return await runExtractionAttempt(runtime, input);
  } catch (error) {
    if (error instanceof SignalExtractorError) throw normalizeConsumerFailure(error);
    if (input.abortSignal?.aborted === true) {
      throw new SignalExtractorError("timeout", "Signal extractor request aborted.", {
        cause: error,
        retryClassification: "failure_aborted"
      });
    }
    throw new SignalExtractorError("transport_failure", "Signal extractor port failed.", {
      cause: error,
      retryClassification: "failure_transport_port"
    });
  }
}

async function runExtractionAttempt(
  runtime: ExtractorRuntime,
  input: ExtractInput
): Promise<{ readonly rawJson: string; readonly extractorMeta?: SignalExtractorMeta }> {
  const message = await runtime.complete(
    runtime.model,
    buildPiMonoContext(input),
    {
      apiKey: runtime.apiKey,
      signal: input.abortSignal,
      timeoutMs: input.timeoutMs,
      maxRetries: DEFAULT_MAX_RETRIES,
      temperature: 0,
      onPayload: requestJsonPayload
    }
  );
  const recovered = recoverAttemptJson(message);
  input.validateRawJson?.(recovered.rawJson);
  return {
    rawJson: recovered.rawJson,
    extractorMeta: {
      recoveryKind: recovered.recoveryKind,
      retryCount: message.executionMeta?.retryCount ?? 0,
      retryClassification: message.executionMeta?.retryClassification ?? "success_first_try"
    }
  };
}

function buildPiMonoContext(input: ExtractInput): PiMonoContext {
  return {
    systemPrompt: input.systemPrompt,
    messages: [
      {
        role: "user",
        content: input.userPrompt,
        timestamp: Date.now()
      }
    ]
  };
}

function recoverAttemptJson(
  message: PiMonoAssistantMessage
): { readonly rawJson: string; readonly recoveryKind: JsonRecoveryKind } {
  // readTextContent throws SignalExtractorError("invalid_json") on empty /
  // oversized text at the consumer boundary.
  const rawText = readTextContent(message);
  const recovered = parseOrRecoverJson(rawText);
  if (recovered !== null) {
    return recovered;
  }
  throw new SignalExtractorError(
    "invalid_json",
    "Signal extractor returned invalid JSON.",
    { retryClassification: "failure_non_retryable_response" }
  );
}

function normalizeConsumerFailure(error: SignalExtractorError): SignalExtractorError {
  if (error.kind !== "invalid_json" ||
      error.retryClassification === "failure_non_retryable_response") return error;
  return new SignalExtractorError(error.kind, error.message, {
    cause: (error as { readonly cause?: unknown }).cause,
    retryCount: error.retryCount,
    retryClassification: "failure_non_retryable_response"
  });
}
