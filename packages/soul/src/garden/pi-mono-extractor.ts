import {
  complete,
  getModel,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions
} from "@earendil-works/pi-ai";

export interface SignalExtractor {
  extract(input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly abortSignal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<{ readonly rawJson: string }>;
}

export type SignalExtractorErrorKind = "timeout" | "transport_failure" | "invalid_json";

export class SignalExtractorError extends Error {
  public constructor(
    public readonly kind: SignalExtractorErrorKind,
    message: string,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
    this.name = "SignalExtractorError";
  }
}

export interface PiMonoExtractorDependencies {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly complete?: PiMonoComplete;
  readonly getModel?: PiMonoGetModel;
}

type PiMonoComplete = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions
) => Promise<AssistantMessage>;

type PiMonoGetModel = (provider: "openai", modelId: string) => Model<Api> | undefined;

const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_RESPONSE_TEXT_CHARS = 256_000;

export function createPiMonoExtractor(deps: PiMonoExtractorDependencies): SignalExtractor {
  const completeImpl = deps.complete ?? complete;
  const getModelImpl = deps.getModel ?? ((provider, modelId) => getModel(provider, modelId as never) as Model<Api> | undefined);
  const selectedModel = selectModel({
    modelId: deps.model,
    endpoint: deps.endpoint,
    getModel: getModelImpl
  });

  return {
    extract: async (input) => {
      let message: AssistantMessage;
      try {
        message = await completeImpl(
          selectedModel,
          {
            systemPrompt: input.systemPrompt,
            messages: [
              {
                role: "user",
                content: input.userPrompt,
                timestamp: Date.now()
              }
            ]
          },
          {
            apiKey: deps.apiKey,
            signal: input.abortSignal,
            timeoutMs: input.timeoutMs,
            maxRetries: DEFAULT_MAX_RETRIES,
            temperature: 0,
            onPayload: requestJsonPayload
          }
        );
      } catch (error) {
        throw mapExtractorTransportError(error, input.abortSignal, input.timeoutMs);
      }

      const rawJson = readTextContent(message);
      assertJsonObject(rawJson);
      return { rawJson };
    }
  };
}

function selectModel(input: {
  readonly modelId: string;
  readonly endpoint?: string;
  readonly getModel: PiMonoGetModel;
}): Model<Api> {
  const baseModel = input.getModel("openai", input.modelId) ?? createOpenAiCompatibleModel(input.modelId);
  if (input.endpoint === undefined) {
    return baseModel;
  }

  return {
    ...baseModel,
    api: "openai-completions",
    baseUrl: normalizeOpenAiBaseUrl(input.endpoint)
  };
}

function createOpenAiCompatibleModel(modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai",
    baseUrl: OPENAI_DEFAULT_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS
  };
}

function requestJsonPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  if ("messages" in payload) {
    return {
      ...payload,
      temperature: 0,
      response_format: { type: "json_object" }
    };
  }

  if ("input" in payload) {
    const existingText = isRecord(payload.text) ? payload.text : {};
    return {
      ...payload,
      temperature: 0,
      text: {
        ...existingText,
        format: { type: "json_object" }
      }
    };
  }

  return payload;
}

function readTextContent(message: AssistantMessage): string {
  const text = message.content
    .filter((block): block is { readonly type: "text"; readonly text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (text.trim().length === 0) {
    throw new SignalExtractorError("invalid_json", "Signal extractor returned no text content.");
  }

  if (text.length > MAX_RESPONSE_TEXT_CHARS) {
    throw new SignalExtractorError("invalid_json", "Signal extractor response exceeded the size limit.");
  }

  return text;
}

function assertJsonObject(rawJson: string): void {
  try {
    JSON.parse(rawJson);
  } catch (error) {
    throw new SignalExtractorError("invalid_json", "Signal extractor returned invalid JSON.", {
      cause: error
    });
  }
}

function mapExtractorTransportError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): SignalExtractorError {
  if (error instanceof SignalExtractorError) {
    return error;
  }

  if (abortSignal?.aborted === true || isTimeoutLike(error)) {
    return new SignalExtractorError(
      "timeout",
      timeoutMs === undefined
        ? "Signal extractor request timed out."
        : `Signal extractor request timed out after ${timeoutMs}ms.`,
      { cause: error }
    );
  }

  return new SignalExtractorError("transport_failure", "Signal extractor request failed.", {
    cause: error
  });
}

function isTimeoutLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /timeout|timed out|abort/u.test(`${error.name} ${error.message}`.toLowerCase());
}

function normalizeOpenAiBaseUrl(endpoint: string): string {
  const withoutTrailingSlash = endpoint.trim().replace(/\/+$/u, "");
  return withoutTrailingSlash.endsWith("/chat/completions")
    ? withoutTrailingSlash.slice(0, -"/chat/completions".length)
    : withoutTrailingSlash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
