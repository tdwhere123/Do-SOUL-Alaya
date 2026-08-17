import {
  fetchProviderChatCompletion,
  normalizeProviderBaseUrl
} from "@do-soul/alaya-engine-gateway";
import {
  createPiMonoExtractor,
  type SignalExtractor
} from "@do-soul/alaya-soul";

export function createOfficialGardenExtractor(input: Readonly<{
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
}>): SignalExtractor {
  const providerUrl = normalizeProviderBaseUrl(
    input.endpoint ?? "https://api.openai.com/v1"
  );
  return createPiMonoExtractor({
    apiKey: input.apiKey,
    model: input.model,
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    complete: async (model, context, options) => {
      const result = await fetchProviderChatCompletion({
        providerUrl: model.baseUrl || providerUrl,
        apiKey: options?.apiKey ?? input.apiKey,
        model: model.id,
        systemPrompt: context.systemPrompt,
        userPrompt: context.messages[0]?.content ?? "",
        temperature: options?.temperature ?? 0,
        timeoutMs: options?.timeoutMs,
        abortSignal: options?.signal,
        mode: "json",
        jsonObject: true
      });
      return {
        content: [{ type: "text", text: result.text }]
      };
    }
  });
}
