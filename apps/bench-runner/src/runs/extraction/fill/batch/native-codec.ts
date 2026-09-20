import { isNativeGeminiRequestProfile, type NativeGeminiRequestProfile } from "../../request-profile.js";
import { findProviderBinding, supportsProviderRequestProfile } from "../../../provider/catalog.js";
import { officialApiExtractionResponseSchema } from "@do-soul/alaya-soul";
import { projectGeminiGenerationSchema } from "./generation-schema.js";

export interface GeminiGenerateContentSettings {
  readonly model: string;
  readonly requestProfile: "provider-default-v1" | NativeGeminiRequestProfile;
  readonly maxOutputTokens: number;
  readonly includeThoughts?: boolean;
}

export function isGeminiGenerateContentProfile(value: unknown): value is GeminiGenerateContentSettings["requestProfile"] {
  return value === "provider-default-v1" || isNativeGeminiRequestProfile(value);
}

const THINKING_CONFIG: Record<NativeGeminiRequestProfile, object> = {
  "gemini-2.5-nonthinking-v1": { thinkingBudget: 0 },
  "gemini-3.1-minimal-v1": { thinkingLevel: "minimal" },
  "gemini-3.1-low-v1": { thinkingLevel: "low" }
};

export function encodeGeminiGenerateContent(
  line: { readonly systemPrompt: string; readonly userPrompt: string },
  settings: GeminiGenerateContentSettings
): object {
  assertGeminiGenerateContentSettings(settings);
  const responseJsonSchema = officialApiExtractionResponseSchema(line.userPrompt);
  const projected = responseJsonSchema === undefined ? undefined : projectGeminiGenerationSchema(responseJsonSchema);
  return {
    systemInstruction: { parts: [{ text: line.systemPrompt },
      ...(projected?.instruction === undefined ? [] : [{ text: projected.instruction }])] },
    contents: [{ role: "user", parts: [{ text: line.userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json", maxOutputTokens: settings.maxOutputTokens,
      ...(projected?.schema === undefined ? {} : { responseJsonSchema: projected.schema }),
      ...(isNativeGeminiRequestProfile(settings.requestProfile) ? {
        thinkingConfig: {
          ...THINKING_CONFIG[settings.requestProfile],
          ...(settings.includeThoughts === true && settings.requestProfile !== "gemini-2.5-nonthinking-v1"
            ? { includeThoughts: true } : {})
        }
      } : {})
    }
  };
}

export class GeminiProviderEnvelopeError extends Error {
  readonly providerCode: unknown;
  constructor(message: string, providerCode?: unknown) {
    super(`Gemini provider error: ${message}`);
    this.name = "GeminiProviderEnvelopeError";
    this.providerCode = providerCode;
  }
}

export function parseGeminiGenerateContentBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("data:") || trimmed.includes("\ndata:")) return assembleGeminiSse(trimmed);
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return assembleGeminiStreamEvents(parsed);
  throwIfGeminiProviderError(parsed);
  return parsed;
}

function assembleGeminiSse(raw: string): unknown {
  const events: unknown[] = [];
  for (const block of raw.split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (data.length === 0 || data === "[DONE]") continue;
    events.push(JSON.parse(data));
  }
  if (events.length === 0) throw new Error("Gemini stream is empty");
  return assembleGeminiStreamEvents(events);
}

function assembleGeminiStreamEvents(events: readonly unknown[]): unknown {
  const texts: string[] = [];
  let finishReason: unknown;
  let usageMetadata: unknown;
  for (const event of events) {
    throwIfGeminiProviderError(event);
    const response = record(event);
    if (response.usageMetadata !== undefined) usageMetadata = response.usageMetadata;
    const candidates = response.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    if (candidates.length !== 1) throw new Error("Gemini response requires one candidate");
    const candidate = record(candidates[0]);
    if (candidate.finishReason !== undefined) finishReason = candidate.finishReason;
    if (candidate.content === undefined) continue;
    const parts = record(candidate.content).parts;
    if (!Array.isArray(parts)) continue;
    for (const partValue of parts) {
      const part = record(partValue);
      if (part.thought === true || part.text === undefined) continue;
      if (typeof part.text !== "string") throw new Error("Gemini response has non-text output");
      texts.push(part.text);
    }
  }
  return {
    candidates: [{ ...(finishReason === undefined ? {} : { finishReason }), content: { parts: [{ text: texts.join("") }] } }],
    ...(usageMetadata === undefined ? {} : { usageMetadata })
  };
}

export function decodeGeminiGenerateContent(value: unknown): {
  readonly rawJson: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
  readonly responseMetadata: { readonly finishReason: "STOP"; readonly completionWitness: "finish_reason";
    readonly completionContractVersion: 1 };
} {
  throwIfGeminiProviderError(value);
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
        !supportsProviderRequestProfile(settings.model, settings.requestProfile)) ||
      !Number.isSafeInteger(settings.maxOutputTokens) || settings.maxOutputTokens <= 0 ||
      (findProviderBinding(settings.model) !== undefined &&
        settings.maxOutputTokens > 65_536)) {
    throw new Error("unsupported Gemini model/request profile/output settings");
  }
}

function throwIfGeminiProviderError(value: unknown): void {
  if (value === undefined || value === null) {
    throw new Error("Gemini response is missing");
  }
  if (typeof value !== "object" || Array.isArray(value)) return;
  const error = (value as { readonly error?: unknown }).error;
  if (error === undefined) return;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    throw new GeminiProviderEnvelopeError("malformed error envelope");
  }
  const body = error as Record<string, unknown>;
  const message = typeof body.message === "string" && body.message.trim().length > 0
    ? body.message
    : "provider error envelope";
  throw new GeminiProviderEnvelopeError(message, body.code);
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
