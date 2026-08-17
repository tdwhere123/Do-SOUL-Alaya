import {
  buildProviderChatRequestInit,
  type ProviderRequestProfile
} from "@do-soul/alaya-engine-gateway";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { resolveExtractionTransportRoute } from "./transport-route.js";

export function buildGardenHttpRequestInit(
  config: CompileSeedExtractionConfig,
  apiKey: string,
  input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly maxOutputTokens?: number;
    readonly outputTokenField?: "max_tokens" | "max_completion_tokens";
  },
  signal: AbortSignal
): RequestInit {
  const transport = resolveExtractionTransportRoute(config);
  return buildProviderChatRequestInit({
    providerUrl: transport.providerUrl,
    apiKey,
    model: transport.model,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    mode: "sse",
    jsonObject: true,
    profile: config.requestProfile as ProviderRequestProfile,
    abortSignal: signal,
    ...(input.maxOutputTokens === undefined ? {} : {
      maxOutputTokens: input.maxOutputTokens,
      outputTokenField: input.outputTokenField
    })
  });
}
