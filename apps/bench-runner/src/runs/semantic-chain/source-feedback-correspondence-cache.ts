import { resolve } from "node:path";
import { canonicalJson, SourceSemanticResourceLedger, SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { fieldContractSha256, type SourceFeedbackCorrespondenceHost,
  type SourceFeedbackCorrespondenceResult } from "@do-soul/alaya-core";
import { readSemanticProposalResults } from "../semantic-proposal/fill.js";
import { semanticProposalWorksetContract, type SemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { SemanticProposalIdentityError } from "../semantic-proposal/artifact.js";

/** Experiment-local, read-only collaborator for daemon executeSourceFeedback. Remove if
 * that experiment is abandoned. No fill authority, provider dispatch, write lease or key allocation. */
export function createSourceFeedbackCorrespondenceCache(input: Readonly<{
  cache_root: string;
  max_output_tokens: number;
  producer: Pick<SemanticProposalWorkset, "model" | "provider_url" | "request_profile" | "producer_id" | "producer_version">;
}>): SourceFeedbackCorrespondenceHost {
  const config = structuredClone({ ...input, cache_root: resolve(input.cache_root) });
  const policy_id = `sha256:${fieldContractSha256(canonicalJson({ consumer: "source-feedback-cache-only", ...config }))}`;
  return { policy_id, async prepare(action) {
    const meter = new SourceSemanticResourceLedger(action.request.budget);
    // These are inclusive host logical debits, not measured native worker/CPU counters.
    const measured = () => ({ native_work: 0, native_bytes: 0, native_accounting: "partial" as const, logical_work: meter.spentWork,
      logical_memory_bytes: meter.spentBytes, rss_bytes: process.memoryUsage().rss });
    const base = { action, new_dispatches: 0 as const, historical_production: { status: "unknown" as const } };
    if (action.request.policy_id !== policy_id) {
      return { ...base, status: "unknown", reason: "host_policy_mismatch" };
    }
    try {
      meter.retain(action, "feedback correspondence action capture");
      meter.retain(config, "feedback correspondence host configuration");
      const { descriptor, original_query, query_semantics } = action.request;
      if (descriptor.interpretation === undefined) {
        return { ...base, work: measured(), status: "unavailable", reason: "descriptor_id_only" };
      }
      const workset: SemanticProposalWorkset = { ...config.producer,
        contract: semanticProposalWorksetContract(config.producer.request_profile), kind: "semantic_correspondence",
        items: [{ original_query, admitted_query_semantics: query_semantics,
          source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id,
            interpretation: descriptor.interpretation }] }] };
      // This owner constructs the real SOUL request and exact wire key, then replays
      // retained raw output through SOUL receive and Core admission. Never a fill fallback.
      const row = readSemanticProposalResults(workset, config.cache_root, config.max_output_tokens, meter)[0]!;
      const historical_production: SourceFeedbackCorrespondenceResult["historical_production"] = row.shard?.usage === undefined
        ? { status: "unknown" } : { status: "reported", usage: row.shard.usage };
      const retained = { ...base, cache_key: row.line.key, historical_production };
      const c = row.received !== undefined && "semantic_correspondence" in row.received ? row.received.semantic_correspondence : undefined;
      if (row.status !== "interpreted" || c === undefined) {
        return { ...retained, work: measured(), status: "unavailable", reason: row.status === "interpreted" ? "no_correspondence" : row.status };
      }
      meter.retain(c, "feedback correspondence result delivery");
      return { ...retained, work: measured(), status: "ready", semantic_correspondence: c };
    } catch (error) {
      // Some cache owners wrap physical read failures. Exhaustion remains distinct even then.
      let cause: unknown = error;
      const seen = new Set<unknown>();
      while (cause instanceof Error && !seen.has(cause)) {
        if (cause instanceof SourceSemanticResourceExhausted) {
          return { ...base, work: measured(), status: "unavailable", reason: "host_budget_exhausted" };
        }
        seen.add(cause); cause = cause.cause;
      }
      if (error instanceof SemanticProposalIdentityError) {
        return { ...base, work: measured(), status: "unavailable", reason: "cache_invalid" };
      }
      // Unexpected host/IO failures cannot assert complete cost or successful absence.
      return { ...base, status: "unknown", reason: "cache_read_failed" };
    }
  } };
}
