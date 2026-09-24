import { AlayaError } from "@do-soul/alaya-protocol";
import { z } from "zod";
import { canonicalPath } from "../fs/opened-contained-path.js";
import { inspectExtractionAttemptLedger, listExtractionAttemptLedgerRecords } from
  "../extraction/authority/attempt-ledger.js";
import { listProviderRawAttempts, verifyProviderRawReservation } from
  "../extraction/fill/provider-raw-attempt.js";
import { chainIdentity } from "../semantic-chain/contract.js";

export type PopulationProducerLayer = "query" | "source" | "correspondence";
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const PopulationAttemptScopeSchema = z.object({ layer: z.enum(["query", "source", "correspondence"]),
  cacheRoot: z.string().min(1), model: z.string().min(1), requestProfile: z.string().min(1),
  keys: z.array(Digest) }).strict();
export const PopulationAttemptEvidenceSchema = z.object({
  inspected_scope_history_complete: z.boolean(), scoped_authorized_attempts: z.number().int().nonnegative().nullable(),
  observed_raw_receipts: z.number().int().nonnegative(), observed_known_usage_attempts: z.number().int().nonnegative(),
  scoped_unknown_usage_attempts: z.number().int().nonnegative().nullable(),
  scoped_reported_input_tokens: z.number().int().nonnegative().nullable(),
  scoped_reported_output_tokens: z.number().int().nonnegative().nullable(), actual_spend: z.null(),
  attempts: z.array(z.object({ layer: z.enum(["query", "source", "correspondence"]),
    cache_root: z.string(), cache_key: Digest, attempt_ordinal: z.number().int().positive(),
    ledger_lineages: z.array(Digest), raw_identity: Digest.nullable(),
    usage: z.object({ input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative() }).strict().nullable() }).strict())
}).strict();
export type PopulationAttemptScope = Readonly<{ layer: PopulationProducerLayer; cacheRoot: string;
  model: string; requestProfile: string; keys: readonly string[] }>;

/** Physical-root and reserved-ordinal projection of native ledgers, never a second spend ledger. */
export function inspectPopulationAttemptScopes(scopes: readonly PopulationAttemptScope[]) {
  const attempts = new Map<string, { layer: PopulationProducerLayer; cache_root: string; cache_key: string;
    attempt_ordinal: number; ledger_lineages: string[]; raw_identity: string | null;
    usage: { input_tokens: number; output_tokens: number } | null }>();
  let complete = scopes.length > 0;
  for (const scope of scopes) {
    if (scope.keys.length === 0) continue;
    const root = canonicalPath(scope.cacheRoot), keys = new Set(scope.keys);
    const ledgers = listExtractionAttemptLedgerRecords(scope.cacheRoot).filter(record =>
      record.cache_identity.model === scope.model && record.cache_identity.requestProfile === scope.requestProfile);
    if (ledgers.length === 0) { complete = false; continue; }
    for (const record of ledgers) {
      const snapshot = inspectExtractionAttemptLedger({ cacheRoot: scope.cacheRoot,
        lineageDigest: record.lineage_digest, cacheIdentity: record.cache_identity });
      if (snapshot === undefined) throw new AlayaError("CONFLICT", "population attempt ledger disappeared during inspection");
      const history = [...snapshot.unresolvedAttempts, ...snapshot.settledAttempts, ...snapshot.transportFailures];
      if (!snapshot.historyComplete) complete = false;
      for (const reservation of history) {
        if (!keys.has(reservation.cacheKey)) continue;
        const id = JSON.stringify([scope.layer, root, scope.model, scope.requestProfile,
          reservation.cacheKey, reservation.attemptOrdinal]);
        const raw = listProviderRawAttempts(scope.cacheRoot, reservation.cacheKey)
          .find(item => item.attempt_ordinal === reservation.attemptOrdinal);
        if (raw !== undefined) {
          if (raw.model !== scope.model || raw.request_profile !== scope.requestProfile ||
              raw.kind !== (scope.layer === "source" ? "source_semantic" :
                scope.layer === "query" ? "query" : "semantic_correspondence")) {
            throw new AlayaError("CONFLICT", "population raw attempt differs from selected producer scope");
          }
          // This projection counts retained attempts; it does not admit their output.
          verifyProviderRawReservation(raw, snapshot, "accounting");
        }
        const rawIdentity = raw === undefined ? null : chainIdentity(raw);
        const usage = raw?.usage_known && raw.usage !== null ?
          { input_tokens: raw.usage.inputTokens, output_tokens: raw.usage.outputTokens } : null;
        const existing = attempts.get(id);
        if (existing !== undefined) {
          if (existing.raw_identity !== rawIdentity ||
              JSON.stringify(existing.usage) !== JSON.stringify(usage)) {
            throw new AlayaError("CONFLICT", "copied attempt ordinal has contradictory raw evidence");
          }
          if (!existing.ledger_lineages.includes(record.lineage_digest)) existing.ledger_lineages.push(record.lineage_digest);
        } else attempts.set(id, { layer: scope.layer, cache_root: root, cache_key: reservation.cacheKey,
          attempt_ordinal: reservation.attemptOrdinal, ledger_lineages: [record.lineage_digest],
          raw_identity: rawIdentity, usage });
      }
    }
    for (const key of keys) {
      const raws = listProviderRawAttempts(scope.cacheRoot, key);
      if (raws.some(raw => ![...attempts.values()].some(attempt => attempt.cache_root === root &&
          attempt.cache_key === key && attempt.attempt_ordinal === raw.attempt_ordinal &&
          attempt.layer === scope.layer))) complete = false;
    }
  }
  const rows = [...attempts.values()].map(row => ({ ...row,
    ledger_lineages: row.ledger_lineages.sort() })).sort((a, b) =>
    JSON.stringify([a.layer, a.cache_root, a.cache_key, a.attempt_ordinal]).localeCompare(
      JSON.stringify([b.layer, b.cache_root, b.cache_key, b.attempt_ordinal])));
  return PopulationAttemptEvidenceSchema.parse({ inspected_scope_history_complete: complete,
    scoped_authorized_attempts: complete ? rows.length : null,
    observed_raw_receipts: rows.filter(row => row.raw_identity !== null).length,
    observed_known_usage_attempts: rows.filter(row => row.usage !== null).length,
    scoped_unknown_usage_attempts: complete ? rows.filter(row => row.usage === null).length : null,
    scoped_reported_input_tokens: complete ? rows.reduce((sum, row) => sum + (row.usage?.input_tokens ?? 0), 0) : null,
    scoped_reported_output_tokens: complete ? rows.reduce((sum, row) => sum + (row.usage?.output_tokens ?? 0), 0) : null,
    actual_spend: null, attempts: rows });
}
