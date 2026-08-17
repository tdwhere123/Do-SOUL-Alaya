import {
  fetchProviderChatCompletion,
  normalizeProviderBaseUrl,
  type ProviderRequestProfile
} from "@do-soul/alaya-engine-gateway";
import {
  createPiMonoExtractor,
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
      const result = await fetchProviderChatCompletion({
        providerUrl: model.baseUrl || providerUrl,
        apiKey: options?.apiKey ?? input.apiKey,
        model: resolveVendorModelAlias(model.id).id,
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
