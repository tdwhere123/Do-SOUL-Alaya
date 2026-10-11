import { isNativeGeminiRequestProfile } from "../extraction/request-profile.js";
import { createHash } from "node:crypto";
import { AlayaError, isChatSemanticRequestProfile, isInternProviderRequestProfile,
  type InternProtocolProbeProfile } from "@do-soul/alaya-protocol";
import { buildProviderChatRequestBody, executeProviderChatCompletion, ProviderChatCompletionError,
  providerChatCompletionsUrl, type ProviderChatCompletionRequest, type ProviderHttpResponseEvidence,
  type ProviderRequestProfile, type ProviderUsage } from "@do-soul/alaya-engine-gateway";
import { sourceBoundF3Seal } from "@do-soul/alaya-soul";
import type { ExtractionRequestProfile } from "../extraction/request-profile.js";
import { requireProviderBinding, resolveVendorModel } from "./catalog.js";
import { createGeminiHttpExtractor } from "../compile-seed/http/gemini-http.js";

export interface ProviderProtocolProbeInput {
  readonly providerUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly requestProfile?: string;
  readonly framing?: "json" | "sse";
  readonly fetchImpl: typeof fetch;
}

export interface ProviderProtocolProbeReceipt {
  readonly profile: ExtractionRequestProfile | InternProtocolProbeProfile;
  readonly model: string;
  readonly framing: "json" | "sse";
  readonly physical_calls: number;
  readonly json_object: boolean;
  readonly usage_present: boolean;
  readonly finish_reason: string | null;
  readonly f3_seal_current: true;
  readonly usage?: ProviderUsage;
  readonly http_response?: ProviderHttpResponseEvidence;
  readonly declared_bounds?: Readonly<{ max_output_tokens: number; timeout_ms: number; maximum_attempts: 1 }>;
  readonly json_schema_valid?: boolean;
  readonly provider_url?: string;
  readonly request_digest?: string;
  readonly failure?: Readonly<{ kind: string; http_status: number | null; provider_code: string | null }>;
}

export async function probeProviderProtocol(
  input: ProviderProtocolProbeInput
): Promise<ProviderProtocolProbeReceipt> {
  void sourceBoundF3Seal();
  if (input.apiKey.trim().length === 0) {
    throw new Error("provider protocol probe refuses an empty API key");
  }
  const binding = requireProviderBinding(input.model);
  const profile = input.requestProfile === undefined || input.requestProfile === binding.requestProfile
    ? binding.requestProfile
    : binding.supportedProbeRequestProfiles?.find(value => value === input.requestProfile);
  if (profile === undefined) throw new AlayaError("VALIDATION", "provider protocol probe profile is not supported by its model binding");
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
  const intern = isInternProviderRequestProfile(profile);
  if (intern && framing !== "json") throw new AlayaError("VALIDATION", "Intern protocol probe supports JSON framing only");
  const timeoutMs = intern ? 180_000 : 20_000;
  const maxOutputTokens = intern ? 8192 : 256;
  if (isNativeGeminiRequestProfile(profile)) {
    if (framing !== "json") throw new Error("Gemini protocol probe supports JSON framing only");
    const response = await createGeminiHttpExtractor({
      providerUrl: input.providerUrl, apiKey: input.apiKey, model,
      requestProfile: profile
    }, fetchImpl).extract({
      systemPrompt: "Return JSON only.", userPrompt: "{\"probe\":true}",
      timeoutMs: 20_000, maxOutputTokens: 256, outputTokenField: "maxOutputTokens",
      retryMode: "disabled", validateRawJson: (raw) => { JSON.parse(raw); }
    });
    return {
      profile, model, framing, physical_calls: physicalCalls,
      json_object: response.rawJson.trim().startsWith("{"),
      usage_present: response.usage !== undefined,
      finish_reason: response.responseMetadata?.finishReason ?? null, f3_seal_current: true
    };
  }
  return probeChatCompletion(input, profile, model, framing, fetchImpl,
    () => physicalCalls, timeoutMs, maxOutputTokens);
}

async function probeChatCompletion(input: ProviderProtocolProbeInput, profile: ProviderRequestProfile,
  model: string, framing: "json" | "sse", fetchImpl: typeof fetch, physicalCalls: () => number,
  timeoutMs: number, maxOutputTokens: number): Promise<ProviderProtocolProbeReceipt> {
  const intern = isInternProviderRequestProfile(profile);
  const request: ProviderChatCompletionRequest = {
    providerUrl: input.providerUrl,
    apiKey: input.apiKey,
    model,
    systemPrompt: "Return JSON only.",
    userPrompt: "{\"probe\":true}",
    profile,
    mode: framing,
    ...(isChatSemanticRequestProfile(profile) || intern ? { retainHttpResponseEvidence: true as const } : {}),
    ...(isChatSemanticRequestProfile(profile) || intern
      ? { jsonSchema: { name: "provider_protocol_probe", schema: {
        type: "object", properties: { probe: { type: "boolean" } },
        required: ["probe"], additionalProperties: false
      } } }
      : { jsonObject: true }),
    timeoutMs,
    maxOutputTokens,
    fetchImpl,
    env: process.env
  };
  const body = buildProviderChatRequestBody(request);
  const url = providerChatCompletionsUrl(input.providerUrl, process.env);
  const declared = intern ? {
    provider_url: input.providerUrl,
    request_digest: createHash("sha256").update(JSON.stringify([url, JSON.stringify(body)])).digest("hex"),
    declared_bounds: { max_output_tokens: maxOutputTokens, timeout_ms: timeoutMs, maximum_attempts: 1 as const }
  } : {};
  let execution;
  try {
    execution = await executeProviderChatCompletion(request, { maxRetries: 0, retryDelaysMs: [] });
  } catch (cause) {
    if (!intern || !(cause instanceof ProviderChatCompletionError)) throw cause;
    return {
      profile, model, framing, physical_calls: physicalCalls(), json_object: false,
      json_schema_valid: false, usage_present: false, finish_reason: null, f3_seal_current: true,
      ...declared,
      failure: { kind: cause.kind, http_status: cause.httpStatus, provider_code: cause.providerCode },
      ...(cause.httpResponse === undefined ? {} : { http_response: cause.httpResponse })
    };
  }
  if (physicalCalls() === 0) {
    throw new Error("provider protocol probe made no physical call");
  }
  return {
    profile,
    model,
    framing,
    physical_calls: physicalCalls(),
    json_object: intern ? probeSchemaValid(execution.result.text) : execution.result.text.trim().startsWith("{"),
    usage_present: execution.result.usage !== undefined,
    finish_reason: execution.result.finishReason,
    f3_seal_current: true,
    ...(execution.result.usage === undefined ? {} : { usage: execution.result.usage }),
    ...(execution.result.httpResponse === undefined ? {} : { http_response: execution.result.httpResponse }),
    ...(intern ? {
      ...declared,
      json_schema_valid: probeSchemaValid(execution.result.text) && execution.result.finishReason === "stop" &&
        execution.result.completion?.mode === "json"
    } : {})
  };
}

function probeSchemaValid(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) &&
      Object.keys(value).length === 1 && "probe" in value && value.probe === true;
  } catch { return false; }
}
