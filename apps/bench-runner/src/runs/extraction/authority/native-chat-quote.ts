import { createHash } from "node:crypto";
import { z } from "zod";
import { AlayaError, canonicalJson, isChatSemanticRequestProfile, isInternSemanticRequestProfile } from "@do-soul/alaya-protocol";
import type { ProviderUsage } from "@do-soul/alaya-engine-gateway";
import { InternQuoteBasisSchema, internQuoteBasisForDigest } from "./intern-quote.js";
import { StepQuoteBasisSchema, stepQuoteBasisForDigest, assertStepQuoteBasis, assertStepQuoteRates } from "./step-quote.js";

export const NativeChatQuoteBasisSchema = z.union([StepQuoteBasisSchema, InternQuoteBasisSchema]);
export type NativeChatQuoteBasis = z.infer<typeof NativeChatQuoteBasisSchema>;

export function nativeChatQuoteBasisForDigest(profile: string, model: string, digest: string): NativeChatQuoteBasis {
  return isInternSemanticRequestProfile(profile)
    ? internQuoteBasisForDigest(model, digest) : stepQuoteBasisForDigest(model, digest);
}

export function nativeChatQuoteBasis(profile: string, model: string, providerUrl: string): NativeChatQuoteBasis {
  return nativeChatQuoteBasisForDigest(profile, model, createHash("sha256").update(providerUrl, "utf8").digest("hex"));
}

export function assertNativeChatQuoteBasis(profile: string, model: string, providerUrl: string, value: unknown): void {
  if (!isInternSemanticRequestProfile(profile)) {
    assertStepQuoteBasis(profile, model, providerUrl, value);
    return;
  }
  if (canonicalJson(NativeChatQuoteBasisSchema.parse(value)) !== canonicalJson(nativeChatQuoteBasis(profile, model, providerUrl))) {
    throw new AlayaError("CONFLICT", "native chat quote differs from its profile, model or route");
  }
}

export function assertNativeChatQuoteRates(profile: string, inputRate: number, outputRate: number,
  quote: NativeChatQuoteBasis | undefined): void {
  if (!isInternSemanticRequestProfile(profile)) {
    assertStepQuoteRates(profile, inputRate, outputRate, quote === undefined ? undefined : StepQuoteBasisSchema.parse(quote));
    return;
  }
  const basis = InternQuoteBasisSchema.parse(quote);
  assertNativeChatQuoteBasis(profile, basis.selected_model, basis.selected_provider_url, basis);
  if (inputRate !== 0 || outputRate !== 0) {
    throw new AlayaError("VALIDATION", "Intern free stage requires published zero rates");
  }
}

/** Inclusive output includes reasoning once; known contradictions are not absent usage. */
export function inspectNativeChatReportedUsage(profile: string, usage: ProviderUsage | null | undefined,
  outputCap: number): "absent" | "valid" | "invalid" {
  if (usage === null || usage === undefined) return "absent";
  if (!isChatSemanticRequestProfile(profile)) return "valid";
  if (!Number.isSafeInteger(outputCap) || outputCap <= 0) {
    throw new AlayaError("CONFLICT", "native chat usage validation requires its authorized output cap");
  }
  if (usage.outputTokens > outputCap || usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
      usage.cachedInputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens ||
      usage.reasoningOutputTokens !== undefined && usage.reasoningOutputTokens > usage.outputTokens) {
    return "invalid";
  }
  return "valid";
}

export function assertNativeChatReportedUsage(profile: string, usage: ProviderUsage | null | undefined, outputCap: number): void {
  if (inspectNativeChatReportedUsage(profile, usage, outputCap) === "invalid") {
    throw new AlayaError("CONFLICT", "native chat reported usage contradicts its authorized output cap or inclusive totals");
  }
}
