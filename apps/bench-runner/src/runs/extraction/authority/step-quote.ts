import { AlayaError } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProviderUsage } from "@do-soul/alaya-engine-gateway";
import { STEP_SEMANTIC_REQUEST_PROFILE } from "../../compile-seed/http/semantic-provider-http.js";

/** Conservative budget policy, not an FX quote or an invoice amount. */
export const STEP_PLAN_QUOTE_BASIS = Object.freeze({
  contract: "step-plan-policy-quote-v1" as const,
  observed_date: "2026-09-23",
  selected_model: "step-3.5-flash-2603",
  selected_provider_url: "https://api.stepfun.com/step_plan/v1",
  pricing_source_url: "https://platform.stepfun.com/docs/zh/guides/pricing/details",
  plan_source_url: "https://platform.stepfun.com/docs/zh/step-plan/overview",
  value_kind: "conservative_policy_usd_equivalent_not_invoice" as const,
  cache_discount_assumed: false as const,
  provider_currency: "CNY" as const,
  plan_credits_per_cny: 1_000_000,
  input_cny_per_million: 0.7,
  output_cny_per_million: 2.1,
  policy_usd_per_cny: 0.20,
  input_usd_equivalent_per_million: 0.14,
  output_usd_equivalent_per_million: 0.42
});

/** Standard OpenAPI billing; no subscription credits or cache discount. */
export const STEP_OPENAPI_QUOTE_BASIS = Object.freeze({
  contract: "step-openapi-policy-quote-v1" as const,
  observed_date: "2026-10-07",
  selected_model: "step-3.5-flash-2603",
  selected_provider_url: "https://api.stepfun.com/v1",
  pricing_source_url: "https://platform.stepfun.com/docs/zh/guides/pricing/details",
  value_kind: "conservative_policy_usd_equivalent_not_invoice" as const,
  cache_discount_assumed: false as const,
  provider_currency: "CNY" as const,
  input_cny_per_million: 0.7,
  output_cny_per_million: 2.1,
  policy_usd_per_cny: 0.20,
  input_usd_equivalent_per_million: 0.14,
  output_usd_equivalent_per_million: 0.42
});

const StepPlanQuoteBasisSchema = z.object({
  contract: z.literal(STEP_PLAN_QUOTE_BASIS.contract),
  observed_date: z.literal(STEP_PLAN_QUOTE_BASIS.observed_date),
  selected_model: z.literal(STEP_PLAN_QUOTE_BASIS.selected_model),
  selected_provider_url: z.literal(STEP_PLAN_QUOTE_BASIS.selected_provider_url),
  pricing_source_url: z.literal(STEP_PLAN_QUOTE_BASIS.pricing_source_url),
  plan_source_url: z.literal(STEP_PLAN_QUOTE_BASIS.plan_source_url),
  value_kind: z.literal(STEP_PLAN_QUOTE_BASIS.value_kind),
  cache_discount_assumed: z.literal(false),
  provider_currency: z.literal("CNY"),
  plan_credits_per_cny: z.literal(STEP_PLAN_QUOTE_BASIS.plan_credits_per_cny),
  input_cny_per_million: z.literal(STEP_PLAN_QUOTE_BASIS.input_cny_per_million),
  output_cny_per_million: z.literal(STEP_PLAN_QUOTE_BASIS.output_cny_per_million),
  policy_usd_per_cny: z.literal(STEP_PLAN_QUOTE_BASIS.policy_usd_per_cny),
  input_usd_equivalent_per_million: z.literal(STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million),
  output_usd_equivalent_per_million: z.literal(STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million),
  transport_url_sha256: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

const StepOpenApiQuoteBasisSchema = z.object({
  contract: z.literal(STEP_OPENAPI_QUOTE_BASIS.contract),
  observed_date: z.literal(STEP_OPENAPI_QUOTE_BASIS.observed_date),
  selected_model: z.literal(STEP_OPENAPI_QUOTE_BASIS.selected_model),
  selected_provider_url: z.literal(STEP_OPENAPI_QUOTE_BASIS.selected_provider_url),
  pricing_source_url: z.literal(STEP_OPENAPI_QUOTE_BASIS.pricing_source_url),
  value_kind: z.literal(STEP_OPENAPI_QUOTE_BASIS.value_kind),
  cache_discount_assumed: z.literal(STEP_OPENAPI_QUOTE_BASIS.cache_discount_assumed),
  provider_currency: z.literal(STEP_OPENAPI_QUOTE_BASIS.provider_currency),
  input_cny_per_million: z.literal(STEP_OPENAPI_QUOTE_BASIS.input_cny_per_million),
  output_cny_per_million: z.literal(STEP_OPENAPI_QUOTE_BASIS.output_cny_per_million),
  policy_usd_per_cny: z.literal(STEP_OPENAPI_QUOTE_BASIS.policy_usd_per_cny),
  input_usd_equivalent_per_million: z.literal(STEP_OPENAPI_QUOTE_BASIS.input_usd_equivalent_per_million),
  output_usd_equivalent_per_million: z.literal(STEP_OPENAPI_QUOTE_BASIS.output_usd_equivalent_per_million),
  transport_url_sha256: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

export const StepQuoteBasisSchema = z.discriminatedUnion("contract", [
  StepPlanQuoteBasisSchema, StepOpenApiQuoteBasisSchema
]);
export type StepQuoteBasis = z.infer<typeof StepQuoteBasisSchema>;

export function stepQuoteBasis(model: string, providerUrl: string): StepQuoteBasis {
  return stepQuoteBasisForDigest(model,
    createHash("sha256").update(providerUrl, "utf8").digest("hex"));
}

export function stepQuoteBasisForDigest(model: string, transportUrlSha256: string): StepQuoteBasis {
  const basis = [STEP_PLAN_QUOTE_BASIS, STEP_OPENAPI_QUOTE_BASIS].find(candidate =>
    candidate.selected_model === model && createHash("sha256")
      .update(candidate.selected_provider_url, "utf8").digest("hex") === transportUrlSha256);
  if (basis === undefined) {
    throw new AlayaError("VALIDATION", "Step quote requires the selected model and an exact supported transport route");
  }
  return StepQuoteBasisSchema.parse({ ...basis,
    transport_url_sha256: transportUrlSha256 });
}

export function assertStepQuoteBasis(
  profile: string, model: string, providerUrl: string, value: unknown
): void {
  if (profile !== STEP_SEMANTIC_REQUEST_PROFILE) {
    if (value !== undefined) throw new AlayaError("CONFLICT", "non-Step authority cannot carry a Step quote");
    return;
  }
  const actual = StepQuoteBasisSchema.parse(value);
  const expected = stepQuoteBasis(model, providerUrl);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AlayaError("CONFLICT", "Step quote differs from its model or transport route");
  }
}

export function assertStepQuoteRates(
  profile: string, inputUsdPerMillion: number, outputUsdPerMillion: number,
  quoteBasis: StepQuoteBasis | undefined
): void {
  if (profile !== STEP_SEMANTIC_REQUEST_PROFILE) return;
  const basis = StepQuoteBasisSchema.parse(quoteBasis);
  assertStepQuoteBasis(profile, basis.selected_model, basis.selected_provider_url, basis);
  if (inputUsdPerMillion !== basis.input_usd_equivalent_per_million ||
      outputUsdPerMillion !== basis.output_usd_equivalent_per_million) {
    throw new AlayaError("VALIDATION", "Step authority requires the frozen route-specific policy quote rates");
  }
}

/** Output includes reasoning; it must never be charged or capped a second time. */
export function assertStepReportedUsage(
  profile: string, usage: ProviderUsage | null | undefined, outputCap: number
): void {
  if (profile !== STEP_SEMANTIC_REQUEST_PROFILE || usage === null || usage === undefined) return;
  if (usage.outputTokens > outputCap ||
      usage.cachedInputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens ||
      usage.reasoningOutputTokens !== undefined && usage.reasoningOutputTokens > usage.outputTokens ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new AlayaError("CONFLICT", "Step reported usage contradicts the frozen output cap or inclusive totals");
  }
}

/** Legacy ledger and cache accounting consume the inclusive base totals. */
export function baseReportedUsage(usage: ProviderUsage | null | undefined):
  { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  return usage === null || usage === undefined ? undefined : {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens
  };
}
