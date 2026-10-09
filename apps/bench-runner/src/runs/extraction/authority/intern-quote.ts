import { createHash } from "node:crypto";
import { z } from "zod";
import { AlayaError, INTERN_SEMANTIC_REQUEST_MODEL, INTERN_SEMANTIC_PROVIDER_URL } from "@do-soul/alaya-protocol";

/** Zero published ink prices need no FX assumption. This is a dated price, not measured usage. */
export const INTERN_DISCOVERY_QUOTE_BASIS = Object.freeze({
  contract: "intern-discovery-free-quote-v1" as const,
  observed_date: "2026-10-09",
  selected_model: INTERN_SEMANTIC_REQUEST_MODEL,
  selected_provider_url: INTERN_SEMANTIC_PROVIDER_URL,
  pricing_source_url: "https://cdn-static.openxlab.org.cn/magic-maker/action-static/tokenplan-doc/quick-start/04-model-limits-and-pricing.md",
  value_kind: "published_zero_ink_price_no_currency_conversion" as const,
  provider_currency: "ink_points" as const,
  limited_time_free: true as const,
  expiry: "not_published" as const,
  cached_input_ink_per_million: 0,
  input_ink_per_million: 0,
  output_ink_per_million: 0,
  input_usd_equivalent_per_million: 0,
  output_usd_equivalent_per_million: 0
});

export const InternQuoteBasisSchema = z.object({
  contract: z.literal(INTERN_DISCOVERY_QUOTE_BASIS.contract),
  observed_date: z.literal(INTERN_DISCOVERY_QUOTE_BASIS.observed_date),
  selected_model: z.literal(INTERN_SEMANTIC_REQUEST_MODEL),
  selected_provider_url: z.literal(INTERN_SEMANTIC_PROVIDER_URL),
  pricing_source_url: z.literal(INTERN_DISCOVERY_QUOTE_BASIS.pricing_source_url),
  value_kind: z.literal(INTERN_DISCOVERY_QUOTE_BASIS.value_kind),
  provider_currency: z.literal(INTERN_DISCOVERY_QUOTE_BASIS.provider_currency),
  limited_time_free: z.literal(true), expiry: z.literal("not_published"),
  cached_input_ink_per_million: z.literal(0), input_ink_per_million: z.literal(0),
  output_ink_per_million: z.literal(0), input_usd_equivalent_per_million: z.literal(0),
  output_usd_equivalent_per_million: z.literal(0),
  transport_url_sha256: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

export function internQuoteBasisForDigest(model: string, transportUrlSha256: string) {
  if (model !== INTERN_SEMANTIC_REQUEST_MODEL || transportUrlSha256 !== createHash("sha256")
    .update(INTERN_SEMANTIC_PROVIDER_URL, "utf8").digest("hex")) {
    throw new AlayaError("VALIDATION", "Intern quote requires exact Agents-A1 Discovery transport");
  }
  return InternQuoteBasisSchema.parse({ ...INTERN_DISCOVERY_QUOTE_BASIS,
    transport_url_sha256: transportUrlSha256 });
}
