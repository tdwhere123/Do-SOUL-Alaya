import { fetchProviderChatCompletion } from "@do-soul/alaya-engine-gateway";
import { assertSourceBoundF3SealCurrent } from "@do-soul/alaya-soul";
import {
  MIMO_MODEL_ID,
  MIMO_PROBE_CALL_CEILING,
  MIMO_REQUEST_PROFILE,
  resolveMimoVendorModel
} from "./profile.js";

export interface MimoProtocolProbeInput {
  readonly providerUrl: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly framing?: "json" | "sse";
  readonly fetchImpl: typeof fetch;
}

export interface MimoProtocolProbeReceipt {
  readonly profile: typeof MIMO_REQUEST_PROFILE;
  readonly model: string;
  readonly framing: "json" | "sse";
  readonly physical_calls: number;
  readonly json_object: boolean;
  readonly usage_present: boolean;
  readonly finish_reason: string | null;
  readonly f3_seal_current: true;
}

export async function probeMimoProtocol(
  input: MimoProtocolProbeInput
): Promise<MimoProtocolProbeReceipt> {
  assertSourceBoundF3SealCurrent();
  if (input.apiKey.trim().length === 0) {
    throw new Error("MiMo protocol probe refuses an empty API key");
  }
  let physicalCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    physicalCalls += 1;
    if (physicalCalls > MIMO_PROBE_CALL_CEILING) {
      throw new Error(`MiMo protocol probe exceeded ${MIMO_PROBE_CALL_CEILING} physical calls`);
    }
    return input.fetchImpl(url, init);
  };
  const model = resolveMimoVendorModel(input.model ?? MIMO_MODEL_ID);
  const framing = input.framing ?? "json";
  const result = await fetchProviderChatCompletion({
    providerUrl: input.providerUrl,
    apiKey: input.apiKey,
    model,
    systemPrompt: "Return JSON only.",
    userPrompt: "{\"probe\":true}",
    profile: MIMO_REQUEST_PROFILE,
    mode: framing,
    jsonObject: true,
    timeoutMs: 20_000,
    maxOutputTokens: 256,
    fetchImpl
  });
  if (physicalCalls === 0) {
    throw new Error("MiMo protocol probe made no physical call");
  }
  return {
    profile: MIMO_REQUEST_PROFILE,
    model,
    framing,
    physical_calls: physicalCalls,
    json_object: result.text.trim().startsWith("{"),
    usage_present: result.usage !== undefined,
    finish_reason: result.finishReason,
    f3_seal_current: true
  };
}
