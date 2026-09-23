import { join } from "node:path";
import { AlayaError, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceSemanticQuery, type SourceSemanticQueryUnavailableReason, type SourceSemanticHandleDescriptor } from "@do-soul/alaya-protocol";
import { admitSourceSemanticQuery, sourceSemanticQueryStatus } from "@do-soul/alaya-core";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import { readSemanticChainProposalResults, semanticChainProposalStates, semanticChainQueryAvailability,
  verifySemanticChainQueries } from "./inputs.js";
import { parseSemanticProposalWorkset, semanticProposalWorksetContract } from "../semantic-proposal/workset.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { SemanticChainConfigSchema, SemanticChainPlanSchema, SEMANTIC_CHAIN_PLAN_CONTRACT, chainIdentity, readChainArtifact, writeChainArtifact,
  writeChainJson, assertChainSnapshot, withSemanticChainDaemon, type SemanticChainConfig, type SemanticChainPlan } from "./contract.js";

export async function prepareSemanticChain(value: unknown, root: string): Promise<SemanticChainPlan> {
  const config = SemanticChainConfigSchema.parse(value);
  assertChainSnapshot(config);
  const results = readSemanticChainProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens);
  const inputIdentity = chainIdentity({ config, queries: semanticChainProposalStates(results) });
  const path = join(root, "prepare.json");
  return withSnapshotPublishLock(path, async () => {
    const existing = readChainArtifact(path);
    if (existing !== undefined) {
      const plan = SemanticChainPlanSchema.parse(existing);
      if (plan.input_identity !== inputIdentity) throw new AlayaError("CONFLICT", "semantic chain preparation inputs changed; use a new stage root");
      verifySemanticChainQueries(plan);
      materializeCorrespondenceWorkset(plan, root);
      return plan;
    }
    const queries: SemanticChainPlan["queries"] = [];
    const items: unknown[] = [];
    const prepare = async (daemon?: BenchDaemonHandle) => {
      for (const row of results) {
        const base = { query_key: row.line.key, original_query: row.line.original_query, raw_digest: row.shard?.raw_digest ?? null };
        const availability = semanticChainQueryAvailability(row);
        const querySemantics = availability.status === "admitted" ? availability.query : undefined;
        const unavailable = availability.status === "unavailable" && availability.unavailable !== "absent"
          ? availability.unavailable : undefined;
        let found;
        try { found = (await discoverSemanticChainQuery(daemon!, config, row.line.original_query, querySemantics, unavailable)).discovery; }
        catch (error) {
          if (!(error instanceof AlayaError && error.code === "UNAVAILABLE")) throw error;
          queries.push({ ...base, status: "blocked", reason: `discovery_unavailable: ${error.message}` });
          continue;
        }
        if (querySemantics === undefined) {
          if (availability.status !== "unavailable") throw new AlayaError("INTERNAL", "raw query availability changed");
          queries.push({ ...base, status: "raw_ready", reason: availability.reason,
            query_semantics_unavailable: availability.unavailable, ...found });
          continue;
        }
        const selected = found.descriptors.filter((descriptor) => descriptor.interpretation !== undefined).slice(0, config.correspondence_pair_cap);
        queries.push({ ...base, status: "ready", query_semantics: querySemantics, ...found,
          selected_source_interpretation_ids: selected.map((entry) => entry.interpretation_id),
          correspondence_opportunities: found.descriptors.map((descriptor) => ({ source_interpretation_id: descriptor.interpretation_id,
            decision: descriptor.interpretation === undefined ? "missing_interpretation" : config.correspondence_pair_cap === 0
              ? "zero_budget" : selected.includes(descriptor) ? "selected" : "not_selected" })) });
        for (const descriptor of selected) items.push({ original_query: row.line.original_query, admitted_query_semantics: querySemantics,
          source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: descriptor.interpretation }] });
      }
    };
    await withSemanticChainDaemon(config, root, prepare);
    const workset = items.length === 0 ? null : parseSemanticProposalWorkset({
      contract: semanticProposalWorksetContract(config.query_workset.request_profile), kind: "semantic_correspondence", model: config.query_workset.model,
      request_profile: config.query_workset.request_profile, provider_url: config.query_workset.provider_url, items
    });
    const plan = SemanticChainPlanSchema.parse({ contract: SEMANTIC_CHAIN_PLAN_CONTRACT, input_identity: inputIdentity,
      config, queries, correspondence_workset: workset });
    writeChainArtifact(path, plan);
    materializeCorrespondenceWorkset(plan, root);
    return plan;
  });
}

function materializeCorrespondenceWorkset(plan: SemanticChainPlan, root: string): void {
  if (plan.correspondence_workset === null) return;
  writeChainJson(join(root, "semantic_correspondence-workset.json"), plan.correspondence_workset);
  // Preflight is a cache-state inspection, not an immutable request. Consumers run the
  // existing proposal prepare command immediately before an authorized fill.
}

export async function discoverSemanticChainQuery(daemon: BenchDaemonHandle, config: SemanticChainConfig, original: string,
  querySemantics?: SourceSemanticQuery, unavailable?: Exclude<SourceSemanticQueryUnavailableReason, "absent">) {
  const descriptors: SourceSemanticHandleDescriptor[] = [];
  const seen = new Set<string>();
  const handles = new Set<string>();
  const trace = [];
  let continuation: string | undefined;
  let queryHandle: string | undefined;
  let pages = 0, open = false, remainingDescriptors = 0;
  let unvisitedInterpretations = false;
  let poolId: string | undefined;
  do {
    const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: original, query_semantics: querySemantics,
        ...(unavailable === undefined ? {} : { query_semantics_unavailable: unavailable }),
        budget: config.budget, authorized_scopes: config.authorized_scopes, access_policy: config.access_policy,
        ...(continuation === undefined ? {} : { continuation_handle: continuation }) })));
    if (response.operation !== "prepare_query") throw new AlayaError("INTERNAL", "native discovery returned a different operation");
    const expectedStatus = sourceSemanticQueryStatus(admitSourceSemanticQuery(querySemantics, original), unavailable);
    if (JSON.stringify(response.query_semantics_status) !== JSON.stringify(expectedStatus)) {
      throw new AlayaError("CONFLICT", "native discovery changed query semantic availability");
    }
    const access = response.access;
    if (access === undefined && response.outcome?.status === "resource_exhausted") {
      throw new AlayaError("UNAVAILABLE", "native discovery resource exhausted");
    }
    if (access === undefined || access.policy !== config.access_policy || access.trace.kind !== "preparation_page") {
      throw new AlayaError("CONFLICT", "native discovery did not bind the frozen access policy");
    }
    if ((poolId !== undefined && access.pool_id !== poolId) || access.trace.interpretation_offset !== descriptors.length) {
      throw new AlayaError("CONFLICT", "native discovery changed its bound candidate pool or offset");
    }
    poolId = access.pool_id;
    queryHandle = response.query_handle;
    trace.push({ coverage: response.coverage, work: response.work, access, query_semantics_status: response.query_semantics_status,
      continuation_handle: response.continuation_handle ?? null,
      candidate_ids: response.candidates.map((candidate) => candidate.interpretation_id) });
    pages++;
    open = response.coverage.discovery !== "complete" || access.unvisited_sources || access.unvisited_interpretations;
    unvisitedInterpretations = access.unvisited_interpretations;
    remainingDescriptors = access.observed_interpretation_count - access.trace.interpretation_offset - response.candidates.length;
    if (remainingDescriptors < 0) throw new AlayaError("CONFLICT", "native discovery exceeded its observed candidate pool");
    for (const descriptor of response.candidates) {
      if (seen.has(descriptor.interpretation_id)) throw new AlayaError("CONFLICT", "native discovery repeated a candidate");
      seen.add(descriptor.interpretation_id); descriptors.push(descriptor);
    }
    continuation = response.continuation_handle;
    if (continuation !== undefined && handles.has(continuation)) throw new AlayaError("CONFLICT", "native discovery continuation did not advance");
    if (continuation !== undefined) handles.add(continuation);
    // Source trace pagination does not create another correspondence opportunity.
  } while (remainingDescriptors > 0 && continuation !== undefined && pages < config.discovery_page_cap);
  return { query_handle: queryHandle, discovery: { descriptors, discovery_trace: trace, discovery_pages: pages, discovery_open: open || remainingDescriptors > 0,
    discovery_truncated: open || remainingDescriptors > 0,
    unvisited_source_interpretation_count: unvisitedInterpretations ? null : 0 } };
}
