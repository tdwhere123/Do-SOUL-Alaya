import { fetchProviderChatCompletion } from "@do-soul/alaya-engine-gateway";
import { assertSourceBoundF3SealCurrent } from "@do-soul/alaya-soul";
import type { ExtractionRequestProfile } from "../extraction/request-profile.js";
import { requireProviderBinding, resolveVendorModel } from "./catalog.js";

export interface ProviderProtocolProbeInput {
  readonly providerUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly framing?: "json" | "sse";
  readonly fetchImpl: typeof fetch;
}

export interface ProviderProtocolProbeReceipt {
  readonly profile: ExtractionRequestProfile;
  readonly model: string;
  readonly framing: "json" | "sse";
  readonly physical_calls: number;
  readonly json_object: boolean;
  readonly usage_present: boolean;
  readonly finish_reason: string | null;
  readonly f3_seal_current: true;
}

export async function probeProviderProtocol(
  input: ProviderProtocolProbeInput
): Promise<ProviderProtocolProbeReceipt> {
  assertSourceBoundF3SealCurrent();
  if (input.apiKey.trim().length === 0) {
    throw new Error("provider protocol probe refuses an empty API key");
  }
  const binding = requireProviderBinding(input.model);
  let physicalCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    physicalCalls += 1;
    if (physicalCalls > binding.probeCallCeiling) {
      throw new Error(
        `provider protocol probe exceeded ${binding.probeCallCeiling} physical calls`
      );
    }
    return input.fetchImpl(url, init);
  };
  const model = resolveVendorModel(input.model);
  const framing = input.framing ?? "json";
  const result = await fetchProviderChatCompletion({
    providerUrl: input.providerUrl,
    apiKey: input.apiKey,
    model,
    systemPrompt: "Return JSON only.",
    userPrompt: "{\"probe\":true}",
    profile: binding.requestProfile,
    mode: framing,
    jsonObject: true,
    timeoutMs: 20_000,
    maxOutputTokens: 256,
    fetchImpl
  });
  if (physicalCalls === 0) {
    throw new Error("provider protocol probe made no physical call");
  }
  return {
    profile: binding.requestProfile,
    model,
    framing,
    physical_calls: physicalCalls,
    json_object: result.text.trim().startsWith("{"),
    usage_present: result.usage !== undefined,
    finish_reason: result.finishReason,
    f3_seal_current: true
  };
}
