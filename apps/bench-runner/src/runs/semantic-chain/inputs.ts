import { canonicalJson } from "@do-soul/alaya-protocol";
import { readSemanticProposalResults } from "../semantic-proposal/fill.js";
import { chainIdentity, type SemanticChainPlan } from "./contract.js";

/** All consumers of a prepared plan bind the same current query-semantics cache state and denominator. */
export function verifySemanticChainQueries(plan: SemanticChainPlan): void {
  const config = plan.config;
  const queries = readSemanticProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens);
  const expected = queries.map((row) => row.line.key).sort();
  const recorded = plan.queries.map((row) => row.query_key).sort();
  if (new Set(expected).size !== expected.length || new Set(recorded).size !== recorded.length
    || canonicalJson(expected) !== canonicalJson(recorded)) throw new Error("prepared query-semantics denominator changed");
  const currentIdentity = chainIdentity({ config, queries: queries.map((row) => ({
    key: row.line.key, raw: row.shard?.raw_digest ?? null, status: row.status
  })) });
  if (currentIdentity !== plan.input_identity) throw new Error("prepared query-semantics state changed before native replay");
  for (const row of plan.queries) {
    const current = queries.find((query) => query.line.key === row.query_key);
    if ((current?.shard?.raw_digest ?? null) !== row.raw_digest ||
        row.status === "ready" && (current?.received === undefined || !("query" in current.received) ||
        canonicalJson(current.received.query) !== canonicalJson(row.query_semantics))) throw new Error("prepared query semantics changed before native replay");
  }
}

export function readSemanticChainCorrespondences(plan: SemanticChainPlan, arm: "retained" | "without_semantic_correspondences") {
  const semantic_correspondences = plan.correspondence_workset === null ? [] : readSemanticProposalResults(
    plan.correspondence_workset, plan.config.correspondence_cache_root, plan.config.max_output_tokens);
  const identity = chainIdentity({ plan, arm, semantic_correspondences: semantic_correspondences.map((row) => ({
    key: row.line.key, raw: row.shard?.raw_digest ?? null, status: row.status
  })) });
  return { semantic_correspondences, identity };
}
