import type { KpiPayload } from "@do-soul/alaya-eval";

const PROVIDER_RATE_FIELDS = [
  "provider_returned_rate",
  "provider_pending_rate",
  "provider_failed_rate",
  "provider_not_requested_rate",
  "provider_unknown_rate",
  "query_embedding_unusable_rate"
] as const satisfies readonly (keyof KpiPayload["kpi"])[];
type ProviderRateField = (typeof PROVIDER_RATE_FIELDS)[number];

/** Shard rates declare populations, not returned/scorable subsets. Preserve the
 * CLI merge's count reconstruction and whole evaluated denominator. A field is
 * reportable only when every shard measured it; historical absence is not zero.
 */
export function mergeProviderStateRates(
  payloads: readonly KpiPayload[]
): Partial<Record<ProviderRateField, number>> {
  const rates: Partial<Record<ProviderRateField, number>> = {};
  if (payloads.length === 0) return rates;
  const evaluated = payloads.reduce((sum, shard) => sum + shard.evaluated_count, 0);
  for (const field of PROVIDER_RATE_FIELDS) {
    if (payloads.some(shard => shard.kpi[field] === undefined)) continue;
    const count = payloads.reduce((sum, shard) =>
      sum + Math.round(shard.kpi[field]! * shard.evaluated_count), 0);
    rates[field] = evaluated === 0 ? 0 : count / evaluated;
  }
  return rates;
}
