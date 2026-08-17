import {
  fetchProviderChatCompletion,
  normalizeProviderBaseUrl,
  type ProviderRequestProfile
} from "@do-soul/alaya-engine-gateway";
import {
  createPiMonoExtractor,
  type SignalExtractor
} from "@do-soul/alaya-soul";

export function createOfficialGardenExtractor(input: Readonly<{
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly profile?: ProviderRequestProfile;
}>): SignalExtractor {
  const providerUrl = normalizeProviderBaseUrl(
    input.endpoint ?? "https://api.openai.com/v1"
  );
  const profile = input.profile ?? mimoProfileFor(input.model);
  return createPiMonoExtractor({
    apiKey: input.apiKey,
    model: input.model,
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    complete: async (model, context, options) => {
      const result = await fetchProviderChatCompletion({
        providerUrl: model.baseUrl || providerUrl,
        apiKey: options?.apiKey ?? input.apiKey,
        model: vendorModelId(model.id),
        systemPrompt: context.systemPrompt,
        userPrompt: context.messages[0]?.content ?? "",
        temperature: options?.temperature ?? 0,
        timeoutMs: options?.timeoutMs,
        abortSignal: options?.signal,
        mode: "json",
        jsonObject: true,
        ...(profile === undefined ? {} : { profile })
      });
      return {
        content: [{ type: "text", text: result.text }]
      };
    }
  });
}

function mimoProfileFor(model: string): ProviderRequestProfile | undefined {
  return vendorModelId(model) === "mimo-v2.5" ? "mimo-v2.5-nonthinking-v1" : undefined;
}

function vendorModelId(model: string): string {
  return model === "Mimo-V2.5" || model === "mimo-v2-flash" ? "mimo-v2.5" : model;
}
