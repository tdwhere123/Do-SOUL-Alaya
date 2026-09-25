import { join, resolve } from "node:path";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { prepareRetainedSemanticProposalRevision } from "../semantic-proposal/fill.js";
import { parseSemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { readSemanticChainProposalResults } from "./inputs.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainArtifact, writeChainJson } from "./contract.js";
import { admitInitialQualified } from "./recovery-publication.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { admitRecoveryNomination } from "./recovery-reason.js";
import { reserveRecoveryRead, reserveRecoveryHostEffect } from "./recovery-allowance.js";

function originalQuery(root: string) {
  const { window, settled } = admitInitialQualified(root);
  const reason = readChainArtifact(join(root, "initial-reason.json")) as { qualified_snapshot_identity?: string } | undefined;
  if (reason?.qualified_snapshot_identity !== settled.publication_identity) {
    throw new AlayaError("CONFLICT", "Q review requires settled initial native reasoning");
  }
  admitRecoveryNomination(root);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json")));
  const query = plan.queries[0];
  if (plan.queries.length !== 1 || query?.status !== "ready") {
    throw new AlayaError("CONFLICT", "Q review requires one admitted frozen original");
  }
  return { plan, query, window, settled };
}

/** This workset exposes only the original Q, its fixed context and exact complete physical parent. */
export function prepareRecoveryQueryReview(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "prepare original-only Q review");
  const { plan, query, settled } = originalQuery(root);
  const revision = prepareRetainedSemanticProposalRevision({ workset: plan.config.query_workset,
    parentCacheRoot: plan.config.query_cache_root, maxOutputTokens: plan.config.max_output_tokens,
    itemIndex: 0, reviewComments: [] });
  const item = plan.config.query_workset.items[0] as Record<string, unknown>;
  const workset = parseSemanticProposalWorkset({ ...plan.config.query_workset,
    revision_parent_cache_root: plan.config.query_cache_root, items: [{ ...item, revision }] });
  const path = join(root, "query-review-workset.json"), cacheRoot = join(root, "query-review-cache");
  reserveRecoveryHostEffect(root, "Q-review-workset", chainIdentity({ workset,
    original: query.query_key, qualified: settled.publication_identity }),
    readChainArtifact(join(root, "query-review-binding.json")) !== undefined);
  writeChainJson(path, workset);
  writeChainArtifact(join(root, "query-review-binding.json"), {
    original_query_key: query.query_key, qualified_snapshot_identity: settled.publication_identity,
    workset_identity: chainIdentity(workset), parent_raw_sha256: revision.previous_response_sha256
  });
  return { workset_path: path, workset_identity: chainIdentity(workset), child_cache_root: cacheRoot };
}

/** A fallible Q review changes active meaning only after the child physical/cache admission. */
function currentRecoveryQueryReview(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "admit Q review physical child");
  const { plan, query, settled } = originalQuery(root);
  const workset = parseSemanticProposalWorkset(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: join(root, "query-review-workset.json"), maxBytes: 32 * 1024 * 1024, label: "Q review workset" })));
  const binding = readChainArtifact(join(root, "query-review-binding.json")) as {
    original_query_key?: string; qualified_snapshot_identity?: string; workset_identity?: string } | undefined;
  if (binding?.original_query_key !== query.query_key ||
      binding.qualified_snapshot_identity !== settled.publication_identity ||
      binding.workset_identity !== chainIdentity(workset)) throw new AlayaError("CONFLICT", "Q review workset changed");
  const results = readSemanticChainProposalResults(workset, join(root, "query-review-cache"), plan.config.max_output_tokens);
  if (results.length !== 1) throw new AlayaError("CONFLICT", "Q review child denominator changed");
  const row = results[0]!;
  if (row.shard === undefined || row.status === "unattempted" || row.status === "pending" ||
      row.status === "unknown" || row.status === "cache_invalid" || row.status === "unavailable") {
    throw new AlayaError("CONFLICT", "Q review has no settled physical child outcome");
  }
  const child = row.received !== undefined && "query" in row.received ? row.received.query : undefined;
  const result = { contract: "source-semantic-query-review-v1", workset_identity: chainIdentity(workset),
    qualified_snapshot_identity: settled.publication_identity, child_key: row.line.key,
    child_status: row.status, child_raw_digest: row.shard?.raw_digest ?? null,
    checkpoint: child === undefined ? "terminal_rejected" : "admitted",
    active_query: child ?? query.query_semantics,
    active_query_origin: child === undefined ? "original" : "admitted_child",
    changed: child !== undefined && canonicalJson(child) !== canonicalJson(query.query_semantics) };
  return { result, workset, cacheRoot: join(root, "query-review-cache"), plan, query };
}

export function settleRecoveryQueryReview(rootInput: string) {
  const root = resolve(rootInput), current = currentRecoveryQueryReview(root);
  reserveRecoveryHostEffect(root, "Q-review-settlement", chainIdentity(current.result),
    readChainArtifact(join(root, "query-review.json")) !== undefined);
  writeChainArtifact(join(root, "query-review.json"), current.result);
  return current.result;
}

/** Every later stage re-admits the terminal physical Q child and its active meaning. */
export function admitRecoveryQueryReview(rootInput: string) {
  const root = resolve(rootInput), current = currentRecoveryQueryReview(root);
  const recorded = readChainArtifact(join(root, "query-review.json"));
  if (recorded === undefined || canonicalJson(recorded) !== canonicalJson(current.result)) {
    throw new AlayaError("CONFLICT", "retained Q review no longer matches its physical child and original");
  }
  return current;
}
