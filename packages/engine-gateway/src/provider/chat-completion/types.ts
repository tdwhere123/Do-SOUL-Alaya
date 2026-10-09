import { INTERN_SEMANTIC_REQUEST_PROFILE, STEP_SEMANTIC_REQUEST_PROFILES, type EnvLookup } from "@do-soul/alaya-protocol";

export const PROVIDER_REQUEST_PROFILES = [
  "provider-default-v1",
  "deepseek-v4-nonthinking-v1",
  "mimo-v2.5-nonthinking-v1",
  ...STEP_SEMANTIC_REQUEST_PROFILES,
  INTERN_SEMANTIC_REQUEST_PROFILE
] as const;

export type ProviderRequestProfile = (typeof PROVIDER_REQUEST_PROFILES)[number];
export type ProviderChatMode = "json" | "sse";
export type ProviderOutputTokenField = "max_tokens" | "max_completion_tokens";
export type ProviderSseCompletionPolicy = "require_witness" | "allow_clean_eof_v1";

export type ProviderJsonSchema = Readonly<{
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}>;

/** Exact received bytes are retained up to the cap; length and digest cover all received bytes. */
export type ProviderHttpResponseEvidence = Readonly<{
  readonly contentType: string | null;
  readonly bodyBase64: string;
  readonly bodyByteLength: number;
  readonly bodySha256: string;
  readonly bodyTruncated: boolean;
  readonly bodyComplete: boolean;
}>;

export type ProviderCompletionWitness = Readonly<{
  readonly mode: "json" | "sse";
  readonly complete: true;
  readonly witness: "message" | "done_sentinel" | "finish_reason" | "profile_clean_eof";
}>;

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
  readonly jsonSchema?: ProviderJsonSchema;
  readonly maxOutputTokens?: number;
  readonly outputTokenField?: ProviderOutputTokenField;
  /** Versioned compatibility authority for providers documented to omit SSE sentinels. */
  readonly sseCompletionPolicy?: ProviderSseCompletionPolicy;
  /** Retain physical response bytes for callers that settle per-request evidence. */
  readonly retainHttpResponseEvidence?: true;
  readonly fetchImpl?: typeof fetch;
  /** Process env bind for private-provider URL opt-in; omit treats private hosts as blocked. */
  readonly env?: EnvLookup;
}>;

export type ProviderUsage = Readonly<{
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
}>;

export type ProviderChatCompletionResult = Readonly<{
  readonly text: string;
  readonly finishReason: string | null;
  readonly usage?: ProviderUsage;
  readonly httpStatus: number;
  readonly completion?: ProviderCompletionWitness;
  readonly reasoningText?: string;
  readonly httpResponse?: ProviderHttpResponseEvidence;
}>;
