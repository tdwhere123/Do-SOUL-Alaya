export const PROVIDER_REQUEST_PROFILES = [
  "provider-default-v1",
  "deepseek-v4-nonthinking-v1",
  "mimo-v2.5-nonthinking-v1"
] as const;

export type ProviderRequestProfile = (typeof PROVIDER_REQUEST_PROFILES)[number];
export type ProviderChatMode = "json" | "sse";
export type ProviderOutputTokenField = "max_tokens" | "max_completion_tokens";

export type ProviderChatCompletionRequest = Readonly<{
  readonly providerUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly mode?: ProviderChatMode;
  readonly profile?: ProviderRequestProfile;
  readonly jsonObject?: boolean;
  readonly maxOutputTokens?: number;
  readonly outputTokenField?: ProviderOutputTokenField;
  readonly fetchImpl?: typeof fetch;
}>;

export type ProviderUsage = Readonly<{
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}>;

export type ProviderChatCompletionResult = Readonly<{
  readonly text: string;
  readonly finishReason: string | null;
  readonly usage?: ProviderUsage;
  readonly httpStatus: number;
}>;
