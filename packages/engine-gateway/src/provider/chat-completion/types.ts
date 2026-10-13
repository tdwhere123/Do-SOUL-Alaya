import { INTERN_SEMANTIC_REQUEST_PROFILES, INTERN_PROTOCOL_PROBE_PROFILES,
  STEP_SEMANTIC_REQUEST_PROFILES, type EnvLookup } from "@do-soul/alaya-protocol";
import type { Agent, Dispatcher } from "undici";

export const PROVIDER_REQUEST_PROFILES = [
  "provider-default-v1",
  "deepseek-v4-nonthinking-v1",
  "mimo-v2.5-nonthinking-v1",
  ...STEP_SEMANTIC_REQUEST_PROFILES,
  ...INTERN_SEMANTIC_REQUEST_PROFILES,
  ...INTERN_PROTOCOL_PROBE_PROFILES.map(row => row.profile)
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
  /** Construct a request-owned Agent/EnvHttpProxyAgent with the supplied factory.
   * Custom proxy/TLS policy belongs here; keep proxy tunneling enabled. The
   * gateway closes this dispatcher after the response, or destroys it on error.
   * Guarded requests do not inspect, replace, or close a custom global dispatcher. */
  readonly transportFactory?: (options: {
    readonly factory: NonNullable<Agent.Options["factory"]>;
    /** Preserve this original-hostname identity when adding custom proxy TLS options. */
    readonly requestTls: { readonly servername: string | undefined };
  }) => Dispatcher;
  /** Composition-root process env bind for URL opt-in and native proxy flags.
   * Omission blocks private hosts and leaves environment proxy flags unset. */
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
