import { canonicalJson } from "@do-soul/alaya-protocol";
import { readSemanticProposalResults } from "../semantic-proposal/fill.js";
import { chainIdentity, type SemanticChainPlan } from "./contract.js";
import { materializeSemanticProposalLines, type SemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { SemanticProposalIdentityError, semanticProposalShardPath } from "../semantic-proposal/artifact.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";

/** Retain failed cache admission in its exact request slot, without repairing or borrowing output. */
export function readSemanticChainProposalResults(workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number) {
  return materializeSemanticProposalLines(workset, maxOutputTokens).map((line, index) => {
    try {
      const result = readSemanticProposalResults({ ...workset, items: [workset.items[index]] }, cacheRoot, maxOutputTokens)[0]!;
      return { ...result, cache_identity: result.shard === undefined ? null : chainIdentity(result.shard) };
    } catch (error) {
      let cacheIdentity = null;
      try { cacheIdentity = hashRegularFileNoFollow(semanticProposalShardPath(cacheRoot, line.key)); } catch { /* Unreadable is not a known cache identity. */ }
      return { line, status: error instanceof SemanticProposalIdentityError ? "cache_invalid" as const : "unavailable" as const,
        cache_identity: cacheIdentity, error: error instanceof Error ? error.message : String(error), shard: undefined, received: undefined };
    }
  });
}

export function semanticChainProposalStates(results: ReturnType<typeof readSemanticChainProposalResults>) {
  return results.map((row) => ({ key: row.line.key, raw: row.shard?.raw_digest ?? null,
    status: row.status, cache_identity: row.cache_identity }));
}

/** All consumers of a prepared plan bind the same current query-semantics cache state and denominator. */
export function verifySemanticChainQueries(plan: SemanticChainPlan): void {
  const config = plan.config;
  const queries = readSemanticChainProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens);
  const expected = queries.map((row) => row.line.key).sort();
  const recorded = plan.queries.map((row) => row.query_key).sort();
  if (new Set(expected).size !== expected.length || new Set(recorded).size !== recorded.length
    || canonicalJson(expected) !== canonicalJson(recorded)) throw new Error("prepared query-semantics denominator changed");
  const currentIdentity = chainIdentity({ config, queries: semanticChainProposalStates(queries) });
  if (currentIdentity !== plan.input_identity) throw new Error("prepared query-semantics state changed before native replay");
  for (const row of plan.queries) {
    const current = queries.find((query) => query.line.key === row.query_key);
    if ((current?.shard?.raw_digest ?? null) !== row.raw_digest ||
        row.status === "ready" && (current?.received === undefined || !("query" in current.received) ||
        canonicalJson(current.received.query) !== canonicalJson(row.query_semantics))) throw new Error("prepared query semantics changed before native replay");
  }
}

export function readSemanticChainCorrespondences(plan: SemanticChainPlan, arm: "retained" | "without_semantic_correspondences") {
  const semantic_correspondences = plan.correspondence_workset === null ? [] : readSemanticChainProposalResults(
    plan.correspondence_workset, plan.config.correspondence_cache_root, plan.config.max_output_tokens);
  const identity = chainIdentity({ plan, arm, semantic_correspondences: semanticChainProposalStates(semantic_correspondences) });
  return { semantic_correspondences, identity };
}
