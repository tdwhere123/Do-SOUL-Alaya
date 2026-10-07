import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  STEP_OPENAPI_QUOTE_BASIS, STEP_PLAN_QUOTE_BASIS, StepQuoteBasisSchema,
  assertStepQuoteBasis, assertStepQuoteRates, stepQuoteBasis, stepQuoteBasisForDigest
} from "../../../../runs/extraction/authority/step-quote.js";

const MODEL = "step-3.5-flash-2603";
const PROFILE = "step-3.5-2603-low-json-schema-v1";
const STANDARD_URL = "https://api.stepfun.com/v1";
const PLAN_URL = "https://api.stepfun.com/step_plan/v1";
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

it("binds ordinary OpenAPI pricing without subscription credits or cache discounts", () => {
  const quote = stepQuoteBasis(MODEL, STANDARD_URL);
  expect(quote).toEqual({
    contract: "step-openapi-policy-quote-v1", observed_date: "2026-10-07",
    selected_model: MODEL, selected_provider_url: STANDARD_URL,
    pricing_source_url: "https://platform.stepfun.com/docs/zh/guides/pricing/details",
    value_kind: "conservative_policy_usd_equivalent_not_invoice",
    cache_discount_assumed: false, provider_currency: "CNY",
    input_cny_per_million: 0.7, output_cny_per_million: 2.1,
    policy_usd_per_cny: 0.20,
    input_usd_equivalent_per_million: 0.14, output_usd_equivalent_per_million: 0.42,
    transport_url_sha256: digest(STANDARD_URL)
  });
  expect(quote).not.toHaveProperty("plan_source_url");
  expect(quote).not.toHaveProperty("plan_credits_per_cny");
  expect(stepQuoteBasisForDigest(MODEL, digest(STANDARD_URL))).toEqual(quote);
  expect(() => assertStepQuoteRates(PROFILE, 0.14, 0.42, quote)).not.toThrow();
  expect(() => assertStepQuoteBasis(PROFILE, MODEL, STANDARD_URL, quote)).not.toThrow();
});

it("keeps historical Plan quote serialization and conservative policy unchanged", () => {
  const legacy = {
    contract: "step-plan-policy-quote-v1", observed_date: "2026-09-23",
    selected_model: MODEL, selected_provider_url: PLAN_URL,
    pricing_source_url: "https://platform.stepfun.com/docs/zh/guides/pricing/details",
    plan_source_url: "https://platform.stepfun.com/docs/zh/step-plan/overview",
    value_kind: "conservative_policy_usd_equivalent_not_invoice",
    cache_discount_assumed: false, provider_currency: "CNY", plan_credits_per_cny: 1_000_000,
    input_cny_per_million: 0.7, output_cny_per_million: 2.1,
    policy_usd_per_cny: 0.20,
    input_usd_equivalent_per_million: 0.14, output_usd_equivalent_per_million: 0.42
  };
  expect(STEP_PLAN_QUOTE_BASIS).toEqual(legacy);
  const serialized = JSON.stringify({ ...legacy, transport_url_sha256: digest(PLAN_URL) });
  expect(JSON.stringify(stepQuoteBasis(MODEL, PLAN_URL))).toBe(serialized);
  expect(JSON.stringify(StepQuoteBasisSchema.parse(JSON.parse(serialized)))).toBe(serialized);
  expect(() => assertStepQuoteRates(PROFILE, 0.14, 0.42, stepQuoteBasis(MODEL, PLAN_URL))).not.toThrow();
});

it("rejects mixed bases, unknown routes, route aliases and other models", () => {
  const standard = stepQuoteBasis(MODEL, STANDARD_URL);
  const plan = stepQuoteBasis(MODEL, PLAN_URL);
  expect(() => assertStepQuoteBasis(PROFILE, MODEL, PLAN_URL, standard)).toThrow(/transport route/u);
  expect(() => assertStepQuoteBasis(PROFILE, MODEL, STANDARD_URL, plan)).toThrow(/transport route/u);
  expect(() => assertStepQuoteBasis(PROFILE, MODEL, STANDARD_URL,
    { ...standard, transport_url_sha256: digest(PLAN_URL) })).toThrow(/transport route/u);
  for (const route of ["https://api.stepfun.com/v1/", "https://api.stepfun.com/v1?mode=standard",
    "https://api.stepfun.com/alternate/v1", "https://other.example.test/v1"]) {
    expect(() => stepQuoteBasis(MODEL, route)).toThrow(/exact supported transport route/u);
  }
  expect(() => stepQuoteBasis("step-3.5-flash", STANDARD_URL)).toThrow(/selected model/u);
  expect(() => stepQuoteBasisForDigest(MODEL, "f".repeat(64))).toThrow(/transport route/u);
});

it("rejects rate, currency-policy and subscription-field tampering in the new basis", () => {
  const quote = stepQuoteBasis(MODEL, STANDARD_URL);
  for (const changed of [
    { input_cny_per_million: 0.6 }, { output_cny_per_million: 2 }, { policy_usd_per_cny: 0.19 },
    { input_usd_equivalent_per_million: 0.13 }, { output_usd_equivalent_per_million: 0.4 },
    { cache_discount_assumed: true }, { plan_credits_per_cny: 1_000_000 },
    { observed_date: "2026-09-23" }
  ]) {
    expect(StepQuoteBasisSchema.safeParse({ ...quote, ...changed }).success).toBe(false);
  }
  expect(() => assertStepQuoteRates(PROFILE, 0.13, 0.42, quote)).toThrow(/frozen route-specific/u);
  expect(() => assertStepQuoteRates(PROFILE, 0.14, 0.4, quote)).toThrow(/frozen route-specific/u);
  expect(() => assertStepQuoteRates(PROFILE, 0.14, 0.42, undefined)).toThrow();
  expect(() => assertStepQuoteBasis("gemini-3.1-minimal-v1", MODEL, STANDARD_URL,
    { ...STEP_OPENAPI_QUOTE_BASIS, transport_url_sha256: digest(STANDARD_URL) })).toThrow(/non-Step/u);
});
