import {
  DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS,
  executeProviderChatCompletion,
  normalizeProviderBaseUrl,
  providerExecutionFailureOf,
  ProviderChatCompletionError,
  type ProviderRequestProfile
} from "@do-soul/alaya-engine-gateway";
import {
  createPiMonoExtractor,
  SignalExtractorError,
  type SignalExtractor
} from "@do-soul/alaya-soul";

type VendorModelAlias = Readonly<{
  readonly id: string;
  readonly aliases: readonly string[];
  readonly profile?: ProviderRequestProfile;
}>;

// Display names stay as aliases so OpenCode Go still receives the vendor
// catalog id (for example mimo-v2.5), not a UI/display label.
const VENDOR_MODEL_ALIASES: readonly VendorModelAlias[] = [
  {
    id: "mimo-v2.5",
    aliases: ["Mimo-V2.5", "mimo-v2-flash"],
    profile: "mimo-v2.5-nonthinking-v1"
  }
];

const OFFICIAL_GARDEN_MAX_RETRIES = 3;

export function createOfficialGardenExtractor(input: Readonly<{
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly profile?: ProviderRequestProfile;
}>): SignalExtractor {
  const providerUrl = normalizeProviderBaseUrl(
    input.endpoint ?? "https://api.openai.com/v1"
  );
  const profile = input.profile ?? resolveVendorModelAlias(input.model).profile;
  return createPiMonoExtractor({
    apiKey: input.apiKey,
    model: input.model,
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    complete: async (model, context, options) => {
      const execution = await executeProviderChatCompletion({
        providerUrl: model.baseUrl || providerUrl,
        apiKey: options?.apiKey ?? input.apiKey,
        model: resolveVendorModelAlias(model.id).id,
        systemPrompt: context.systemPrompt,
        userPrompt: context.messages[0]?.content ?? "",
        temperature: options?.temperature ?? 0,
        timeoutMs: options?.timeoutMs ?? DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS,
        abortSignal: options?.signal,
        mode: "json",
        jsonObject: true,
        ...(profile === undefined ? {} : { profile })
      }, {
        maxRetries: OFFICIAL_GARDEN_MAX_RETRIES,
        retryDelaysMs: [],
        retryJitter: { baseMs: 250, maxMs: 1_500, random: Math.random },
        maxTimeoutRetries: 1,
        retryNetworkErrors: true,
        retryBodyReadErrors: true
      }).catch((error: unknown) => {
        throw toSignalExtractorTransportError(error);
      });
      return {
        content: [{ type: "text", text: execution.result.text }],
        executionMeta: {
          retryCount: execution.retryCount,
          retryClassification: execution.retryClassification
        }
      };
    }
  });
}

function toSignalExtractorTransportError(error: unknown): SignalExtractorError {
  const execution = providerExecutionFailureOf(error);
  const kind = error instanceof ProviderChatCompletionError && error.kind === "timeout"
    ? "timeout"
    : "transport_failure";
  return new SignalExtractorError(kind, "Signal extractor request failed.", {
    cause: error,
    retryCount: execution?.retryCount ?? 0,
    retryClassification: execution?.retryClassification ?? "failure_transport_port"
  });
}

export function resolveVendorModelAlias(model: string): Readonly<{
  readonly id: string;
  readonly profile?: ProviderRequestProfile;
}> {
  const normalized = model.trim();
  const row = VENDOR_MODEL_ALIASES.find(
    (entry) => entry.id === normalized || entry.aliases.includes(normalized)
  );
  if (row === undefined) {
    return { id: model };
  }
  return row.profile === undefined
    ? { id: row.id }
    : { id: row.id, profile: row.profile };
}
