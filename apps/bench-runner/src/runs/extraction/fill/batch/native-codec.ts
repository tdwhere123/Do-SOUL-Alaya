import { isNativeGeminiRequestProfile, type NativeGeminiRequestProfile } from "../../request-profile.js";
import { findProviderBinding } from "../../../provider/catalog.js";
import { officialApiExtractionResponseSchema } from "@do-soul/alaya-soul";

export interface GeminiGenerateContentSettings {
  readonly model: string;
  readonly requestProfile: "provider-default-v1" | NativeGeminiRequestProfile;
  readonly maxOutputTokens: number;
}

export function isGeminiGenerateContentProfile(value: unknown): value is GeminiGenerateContentSettings["requestProfile"] {
  return value === "provider-default-v1" || isNativeGeminiRequestProfile(value);
}

const THINKING_CONFIG: Record<NativeGeminiRequestProfile, object> = {
  "gemini-2.5-nonthinking-v1": { thinkingBudget: 0 },
  "gemini-3.1-minimal-v1": { thinkingLevel: "minimal" }
};

export function encodeGeminiGenerateContent(
  line: { readonly systemPrompt: string; readonly userPrompt: string },
  settings: GeminiGenerateContentSettings
): object {
  assertGeminiGenerateContentSettings(settings);
  const responseJsonSchema = officialApiExtractionResponseSchema(line.userPrompt);
  return {
    systemInstruction: { parts: [{ text: line.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: line.userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json", maxOutputTokens: settings.maxOutputTokens,
      ...(responseJsonSchema === undefined ? {} : { responseJsonSchema }),
      ...(isNativeGeminiRequestProfile(settings.requestProfile) ? {
        thinkingConfig: THINKING_CONFIG[settings.requestProfile]
      } : {})
    }
  };
}

export function decodeGeminiGenerateContent(value: unknown): {
  readonly rawJson: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
  readonly responseMetadata: { readonly finishReason: "STOP"; readonly completionWitness: "finish_reason";
    readonly completionContractVersion: 1 };
} {
  const response = record(value);
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1) throw new Error("Gemini response requires one candidate");
  const candidate = record(candidates[0]);
  if (candidate.finishReason !== "STOP") throw new Error("Gemini response is truncated or not complete");
  const parts = record(candidate.content).parts;
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("Gemini response content missing");
  const text: string[] = [];
  for (const partValue of parts) {
    const part = record(partValue);
    if (part.thought === true) continue;
    if (typeof part.text !== "string") throw new Error("Gemini response has non-text output");
    text.push(part.text);
  }
  const rawJson = text.join("");
  if (!rawJson.trim()) throw new Error("Gemini response is empty");
  const usage = geminiUsage(response);
  return {
    rawJson, ...(usage === undefined ? {} : { usage }),
    responseMetadata: { finishReason: "STOP", completionWitness: "finish_reason", completionContractVersion: 1 }
  };
}

export function geminiUsage(response: Record<string, unknown>): {
  inputTokens: number; outputTokens: number; totalTokens: number;
} | undefined {
  if (response.usageMetadata === undefined) return undefined;
  const usage = record(response.usageMetadata);
  const input = usage.promptTokenCount;
  const candidates = usage.candidatesTokenCount;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  const total = usage.totalTokenCount;
  if (![input, candidates, thoughts, total].every((n) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
  const output = (candidates as number) + (thoughts as number);
  if (!Number.isSafeInteger(output) || (total as number) < (input as number) + output) return undefined;
  return { inputTokens: input as number, outputTokens: output, totalTokens: total as number };
}

export function assertGeminiGenerateContentSettings(settings: GeminiGenerateContentSettings): void {
  if (!/^gemini-[a-zA-Z0-9._-]+$/u.test(settings.model) ||
      !isGeminiGenerateContentProfile(settings.requestProfile) ||
      (isNativeGeminiRequestProfile(settings.requestProfile) &&
        findProviderBinding(settings.model)?.requestProfile !== settings.requestProfile) ||
      !Number.isSafeInteger(settings.maxOutputTokens) || settings.maxOutputTokens <= 0 ||
      (findProviderBinding(settings.model) !== undefined &&
        settings.maxOutputTokens > 65_536)) {
    throw new Error("unsupported Gemini model/request profile/output settings");
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("malformed Gemini object");
  }
  return value as Record<string, unknown>;
}

export function resourceName(value: unknown, kind: "files" | "batches"): string {
  if (typeof value !== "string" || !new RegExp(`^${kind}/[a-zA-Z0-9_-]+$`, "u").test(value)) {
    throw new Error(`invalid Gemini Batch ${kind} resource name`);
  }
  return value;
}
