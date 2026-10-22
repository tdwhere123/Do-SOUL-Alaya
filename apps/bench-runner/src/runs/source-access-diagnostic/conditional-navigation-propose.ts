import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError } from "@do-soul/alaya-protocol";
import { resolveCompileSeedExtractionConfig } from "../compile-seed/compile-seed-config.js";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { prepareEvidenceSelection, executeEvidenceSelectionFill, readEvidenceSelectionResults } from "../evidence-selection/execute.js";
import { materializeEvidenceSelectionLines, parseEvidenceSelectionWorkset } from "../evidence-selection/input.js";
import { pinEvidenceSelectionAuthority, quoteEvidenceSelection } from "../evidence-selection/authority.js";
import { openEvidenceSelectionAttemptLedger } from "../evidence-selection/attempt.js";
import { INPUT_NAVIGATION_POLICY, FormationInputSchema, type FormationCapture } from "./input-condition-formation.js";
import { navigationFileDigest } from "./conditional-navigation-run.js";

export const NavigationProposalInputsSchema = z.object({ source_revision: z.string().min(1),
  rows: z.array(z.object({ ordinal: z.number().int().min(1).max(8), input: FormationInputSchema }).strict()).min(1).max(8) }).strict();
const OUTPUT_CAP = 8192;

/** Separate live phase. Exact wire material and the native authority freeze before any issuance.
 * No resume/revision/retry entry: retained outcomes are read through their existing owner. */
export async function runNavigationProposals(value: unknown, output: string, configOverride?: CompileSeedExtractionConfig,
  extractor?: Parameters<typeof executeEvidenceSelectionFill>[0]["extractor"]) {
  const input = NavigationProposalInputsSchema.parse(value), root = resolve(output), cacheRoot = join(root, "cache");
  if (existsSync(root) || new Set(input.rows.map(row => row.ordinal)).size !== input.rows.length) {
    throw new AlayaError("CONFLICT", "proposal output must be new and ordinals unique");
  }
  const workset = parseEvidenceSelectionWorkset({ contract: "source-evidence-selection-workset-v1",
    model: "step-3.5-flash-2603", provider_url: "https://api.stepfun.com/v1", request_profile: "step-3.5-2603-low-json-schema-v1",
    request_policy: INPUT_NAVIGATION_POLICY, items: input.rows.map(row => ({ original_question: row.input.question,
      metadata: { reference_clock: row.input.reference_clock }, sources: [] })) });
  const lines = materializeEvidenceSelectionLines(workset, OUTPUT_CAP);
  if (lines.some(line => line.inputByteUpper > 16 * 1024) || new Set(lines.map(line => line.key)).size !== lines.length) {
    throw new AlayaError("CONFLICT", "proposal request exceeds input bound or repeats a task key");
  }
  const preflight = prepareEvidenceSelection(workset, cacheRoot, OUTPUT_CAP);
  const basis = preflight.quote_basis!;
  const authority = pinEvidenceSelectionAuthority({ preflight, inputUsdPerMillion: basis.input_usd_equivalent_per_million,
    outputUsdPerMillion: basis.output_usd_equivalent_per_million, spendCeilingUsd: 0.25 * basis.policy_usd_per_cny });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "request.json"), JSON.stringify({ input, workset, lines, preflight, authority,
    task: INPUT_NAVIGATION_POLICY, reservation: { policy_upper_cny: authority.price.estimated_upper_usd / basis.policy_usd_per_cny,
      historical_unresolved_cny: 0.15, total_reserved_cny: 0.15 + authority.price.estimated_upper_usd / basis.policy_usd_per_cny,
      invoice: "unknown", attempts_per_key: 1, serial: true, provider_wall_ms: 45 * 60_000 } }, null, 2), { flag: "wx" });
  const config = configOverride ?? resolveCompileSeedExtractionConfig({ ...process.env,
    OFFICIAL_API_GARDEN_MODEL: workset.model, OFFICIAL_API_GARDEN_PROVIDER_URL: workset.provider_url,
    ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: workset.request_profile,
    ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL: "", ALAYA_BENCH_EXTRACTION_TRANSPORT_PROVIDER_URL: "" });
  let failure: string | null = null;
  try { await executeEvidenceSelectionFill({ workset, cacheRoot, authority, config, ...(extractor ? { extractor } : {}) }); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const results = readEvidenceSelectionResults(workset, cacheRoot, OUTPUT_CAP);
  const captures = results.map((result, i) => {
    const row = input.rows[i]!, shard = result.shard;
    const usableUsage = shard?.usage !== undefined && shard.usage.inputTokens <= result.line.inputByteUpper;
    const outcome = shard?.outcome;
    const reason = typeof outcome === "object" && outcome !== null && "reason" in outcome ? String(outcome.reason) : result.status;
    const capture: FormationCapture = { task: INPUT_NAVIGATION_POLICY, input: row.input,
      state: result.status === "unknown" || result.status === "pending" ? "unknown"
        : (result.status === "interpreted" || result.status === "abstained") && usableUsage ? "complete"
        : !usableUsage && shard !== undefined ? "unknown"
          : result.status === "unattempted" ? "unavailable"
          : result.status === "incomplete" || result.status === "transport_failure" ? result.status
          : reason === "malformed_json" ? "malformed" : "rejected",
      raw_json: shard?.raw_json ?? null, provenance: `${join(root, "request.json")};sha256:${navigationFileDigest(join(root, "request.json"))};key:${result.line.key}`,
      reason: (result.status === "interpreted" || result.status === "abstained") && usableUsage ? null : failure ?? reason };
    return { ordinal: row.ordinal, capture };
  });
  const ledger = openEvidenceSelectionAttemptLedger({ cacheRoot, authority }).snapshot();
  const telemetry = ledger.telemetry;
  const knownPolicyCny = quoteEvidenceSelection({ maximum_attempts: 1, maximum_input_tokens_per_attempt: telemetry.inputTokens,
    max_output_tokens: telemetry.outputTokens }, basis.input_usd_equivalent_per_million,
  basis.output_usd_equivalent_per_million) / basis.policy_usd_per_cny;
  const unknown = telemetry.usageUnavailableRequests + ledger.unresolvedAttempts.length
    + results.filter(result => result.shard?.usage !== undefined && result.shard.usage.inputTokens > result.line.inputByteUpper).length;
  const perAttemptCny = authority.price.estimated_upper_usd / basis.policy_usd_per_cny / authority.keys.length;
  const receipt = { task: INPUT_NAVIGATION_POLICY, status: results.every(row => row.status === "interpreted") && captures.every(row => row.capture.state === "complete") ? "complete" : "stopped",
    failure, request_sha256: navigationFileDigest(join(root, "request.json")), captures, ledger,
    outcomes: results.map((result, i) => ({ ordinal: input.rows[i]!.ordinal, status: result.status, outcome: result.shard?.outcome ?? null })),
    cost: { actual_provider_calls: ledger.attempts, reported_policy_cny: knownPolicyCny, invoice_cny: null,
      outstanding_maximum_cny: 0.15 + unknown * perAttemptCny, historical_unresolved_cny: 0.15,
      unknown_usage_attempts: unknown, unissued_keys_closed: authority.keys.length - ledger.attempts,
      policy_quote_cny: authority.price.estimated_upper_usd / basis.policy_usd_per_cny } };
  writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
  return receipt;
}
