import { AlayaError, canonicalJson, type SourceSemanticCorrespondence,
  type SourceSemanticQueryUnavailableReason } from "@do-soul/alaya-protocol";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { readSemanticProposalResults } from "../semantic-proposal/fill.js";
import { chainIdentity, readChainArtifactPayloadForInventory, retainedArtifactField,
  retainedArtifactPathField, type SemanticChainConfig, type SemanticChainPlan } from "./contract.js";
import { materializeSemanticProposalLines, type SemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { SemanticProposalWorksetSchema } from "../semantic-proposal/workset.js";
import { semanticProposalCacheInputPaths } from "../semantic-proposal/attempt.js";
import { SemanticProposalIdentityError, semanticProposalShardPath } from "../semantic-proposal/artifact.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { ProviderRawAttemptIdentityError } from "../extraction/fill/provider-raw-attempt.js";
import { ExtractionAttemptLimitError } from "../extraction/authority/attempt-ledger.js";
import { join } from "node:path";

/** Retained plans expose readable cache inputs without admitting the plan or its execution state. */
export function semanticChainCacheInputPaths(value: unknown): readonly string[] {
  const paths: string[] = [];
  for (const key of ["cache_root", "preparation_path"] as const) {
    const path = retainedArtifactPathField(value, "config", "source_index", key);
    if (path !== undefined) paths.push(path);
  }
  const tokens = retainedArtifactField(value, "config", "max_output_tokens");
  const generationCap = retainedArtifactField(value, "config", "correspondence_generation", "max_output_tokens");
  const correspondenceTokens = typeof generationCap === "number" ? generationCap : tokens;
  const owners = retainedArtifactField(value, "config", "correspondence_cache_owners");
  for (const [rootKeys, worksetKeys] of [
    [["config", "query_cache_root"], ["config", "query_workset"]],
    [["config", "correspondence_cache_root"], ["correspondence_workset"]]
  ] as const) {
    if (rootKeys[1] === "correspondence_cache_root" && Array.isArray(owners)) continue;
    const root = retainedArtifactPathField(value, ...rootKeys);
    if (root === undefined) continue;
    paths.push(root);
    const workset = SemanticProposalWorksetSchema.safeParse(retainedArtifactField(value, ...worksetKeys));
    const cap = rootKeys[1] === "correspondence_cache_root" ? correspondenceTokens : tokens;
    if (workset.success && typeof cap === "number" && Number.isInteger(cap) && cap >= 1 && cap <= 65536) {
      paths.push(...semanticProposalCacheInputPaths(workset.data, root, cap));
    }
  }
  const workset = SemanticProposalWorksetSchema.safeParse(retainedArtifactField(value, "correspondence_workset"));
  if (Array.isArray(owners) && workset.success && typeof correspondenceTokens === "number" &&
      Number.isInteger(correspondenceTokens) && correspondenceTokens >= 1 && correspondenceTokens <= 65536) {
    for (const owner of owners) {
      if (typeof owner !== "object" || owner === null || typeof owner.key !== "string" ||
          typeof owner.cache_root !== "string") continue;
      const items = workset.data.items.filter(item => {
        try { return materializeSemanticProposalLines({ ...workset.data, items: [item] }, correspondenceTokens)[0]?.key === owner.key; }
        catch { return false; }
      });
      if (items.length === 1) paths.push(...semanticProposalCacheInputPaths({ ...workset.data, items }, owner.cache_root, correspondenceTokens));
    }
  }
  return paths;
}

export function retainedSemanticChainCacheInputPaths(root: string): readonly string[] {
  return semanticChainCacheInputPaths(readChainArtifactPayloadForInventory(join(root, "prepare.json")));
}

/** Retain failed cache admission in its exact request slot, without repairing or borrowing output. */
export function readSemanticChainProposalResults(workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number) {
  return materializeSemanticProposalLines(workset, maxOutputTokens).map((line, index) => {
    try {
      const item = workset.items[index];
      const revised = typeof item === "object" && item !== null && "revision" in item;
      const { revision_parent_cache_root: parentRoot, ...base } = workset;
      const single = { ...base, ...(revised && parentRoot !== undefined
        ? { revision_parent_cache_root: parentRoot } : {}), items: [item] };
      const result = readSemanticProposalResults(single, cacheRoot, maxOutputTokens)[0]!;
      return { ...result, cache_identity: result.shard === undefined ? null : chainIdentity(result.shard) };
    } catch (error) {
      let cacheIdentity = null;
      try { cacheIdentity = hashRegularFileNoFollow(semanticProposalShardPath(cacheRoot, line.key)); } catch { /* Unreadable is not a known cache identity. */ }
      return { line, status: error instanceof SemanticProposalIdentityError || error instanceof ProviderRawAttemptIdentityError ||
        error instanceof ExtractionAttemptLimitError ? "cache_invalid" as const : "unavailable" as const,
        cache_identity: cacheIdentity, error: error instanceof Error ? error.message : String(error), shard: undefined, received: undefined };
    }
  });
}

export function semanticChainProposalStates(results: ReturnType<typeof readSemanticChainProposalResults>) {
  return results.map((row) => ({ key: row.line.key, raw: row.shard?.raw_digest ?? null,
    status: row.status, cache_identity: row.cache_identity }));
}

export function semanticChainPreparationIdentity(config: SemanticChainConfig,
  results: ReturnType<typeof readSemanticChainProposalResults>, settledInput?: SemanticChainPlan["settled_input"]): string {
  return chainIdentity({ config, queries: semanticChainProposalStates(results),
    ...(settledInput === undefined ? {} : { settled_input: settledInput }) });
}

/** Cache/ledger status is retained separately from what can be declared to native recall. */
export function semanticChainQueryAvailability(row: ReturnType<typeof readSemanticChainProposalResults>[number]) {
  const query = row.received !== undefined && "query" in row.received ? row.received.query : undefined;
  if (query !== undefined) return { status: "admitted" as const, query };
  const unavailable: SourceSemanticQueryUnavailableReason = row.status === "unattempted" ? "absent"
    : row.status === "invalid" || row.status === "core_rejected" || row.status === "cache_invalid" ? "invalid"
    : row.status === "unknown" || row.status === "pending" ? "producer_outcome_unknown"
    : row.status === "unavailable" ? "cache_unavailable" : "producer_failure";
  return { status: "unavailable" as const, reason: row.status, unavailable };
}

/** All consumers of a prepared plan bind the same current query-semantics cache state and denominator. */
export function verifySemanticChainQueries(plan: SemanticChainPlan): void {
  const config = plan.config;
  const queries = readSemanticChainProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens);
  const expected = queries.map((row) => row.line.key).sort();
  const recorded = plan.queries.map((row) => row.query_key).sort();
  if (new Set(expected).size !== expected.length || new Set(recorded).size !== recorded.length
    || canonicalJson(expected) !== canonicalJson(recorded)) throw new AlayaError("CONFLICT", "prepared query-semantics denominator changed");
  const currentIdentity = semanticChainPreparationIdentity(config, queries, plan.settled_input);
  if (currentIdentity !== plan.input_identity) throw new AlayaError("CONFLICT", "prepared query-semantics state changed before native replay");
  for (const row of plan.queries) {
    const current = queries.find((query) => query.line.key === row.query_key);
    const availability = current === undefined ? undefined : semanticChainQueryAvailability(current);
    if (current === undefined || current.line.original_query !== row.original_query ||
        (current.shard?.raw_digest ?? null) !== row.raw_digest ||
        row.status === "ready" && (availability?.status !== "admitted" ||
        canonicalJson(availability.query) !== canonicalJson(row.query_semantics))) {
      throw new AlayaError("CONFLICT", "prepared query semantics changed before native replay");
    }
    if (row.status === "raw_ready" && (availability?.status !== "unavailable" || row.reason !== availability.reason ||
      row.query_semantics_unavailable !== availability.unavailable)) {
      throw new AlayaError("CONFLICT", "prepared query failure state or declaration changed before native replay");
    }
    if (row.status === "blocked" && !row.reason.startsWith("discovery_unavailable: ")) {
      throw new AlayaError("CONFLICT", "blocked query lacks an inspectable native discovery failure");
    }
  }
}

export function readSemanticChainCorrespondences(plan: SemanticChainPlan, arm: "retained" | "without_semantic_correspondences") {
  const semantic_correspondences = plan.correspondence_workset === null ? [] : readSemanticChainCorrespondenceOwners(
    plan.correspondence_workset, plan.config.correspondence_cache_root,
    plan.config.correspondence_generation?.max_output_tokens ?? plan.config.max_output_tokens,
    plan.config.correspondence_cache_owners);
  const identity = chainIdentity({ plan, arm, semantic_correspondences: semanticChainProposalStates(semantic_correspondences) });
  return { semantic_correspondences, identity };
}

/** Each exact C key retains its own physical attempt root, including warm unchanged keys. */
export function readSemanticChainCorrespondenceOwners(workset: SemanticProposalWorkset, defaultRoot: string,
  cap: number, owners?: readonly { key: string; cache_root: string }[]) {
  const lines = materializeSemanticProposalLines(workset, cap);
  if (owners !== undefined && (owners.length !== lines.length ||
      new Set(owners.map(owner => owner.key)).size !== owners.length ||
      lines.some(line => !owners.some(owner => owner.key === line.key)))) {
    throw new AlayaError("CONFLICT", "correspondence cache owners do not cover the exact current request set");
  }
  return lines.flatMap((line, index) => readSemanticChainProposalResults({ ...workset, items: [workset.items[index]] },
    owners?.find(owner => owner.key === line.key)?.cache_root ?? defaultRoot, cap));
}

/** Replay and archive admission use the same per-query correspondence set and retained outcomes. */
export function semanticChainQueryCorrespondences(query: Extract<SemanticChainPlan["queries"][number], { status: "ready" }>,
  semanticCorrespondences: ReturnType<typeof readSemanticChainCorrespondences>["semantic_correspondences"]) {
  const ready: SourceSemanticCorrespondence[] = [];
  const outcomes = query.descriptors.flatMap((descriptor) => {
    const matching = semanticCorrespondences.filter((row) => {
      const request = row.line.request as SourceSemanticCorrespondenceRequest;
      return row.line.original_query === query.original_query &&
        request.source_interpretation_descriptors[0]?.source_interpretation_id === descriptor.interpretation_id &&
        canonicalJson(request.admitted_query_semantics) === canonicalJson(query.query_semantics);
    });
    // Each bounded assessment remains a separate premise and attempt. Completing
    // one demand does not consume or hide another demand for the same Q/H.
    return (matching.length === 0 ? [undefined] : matching).map((found) => {
      if (found?.received !== undefined && "semantic_correspondence" in found.received && found.received.semantic_correspondence !== undefined) {
        ready.push(found.received.semantic_correspondence);
      }
      const request = found?.line.request as SourceSemanticCorrespondenceRequest | undefined;
      return { source_interpretation_id: descriptor.interpretation_id, status: found?.status ?? "unattempted",
        ...(request?.generation_policy === undefined ? {} : { generation_policy: request.generation_policy,
          demand: request.demand, coverage: found?.received !== undefined && "coverage" in found.received
            ? found.received.coverage ?? null : null }),
        reason: query.correspondence_opportunities.find((entry) => entry.source_interpretation_id === descriptor.interpretation_id)!.decision,
        core_admitted: found?.received !== undefined,
        admitted_endpoint_pairs: found?.received !== undefined && "semantic_correspondence" in found.received
          ? found.received.semantic_correspondence?.correspondences.length ?? null : null,
        attempt_ordinal: found?.shard?.attempt_ordinal ?? null, producer_usage: found?.shard?.usage ?? null,
        key: found?.line.key ?? null, raw_digest: found?.shard?.raw_digest ?? null, cache_identity: found?.cache_identity ?? null };
    });
  });
  return { ready, outcomes };
}
