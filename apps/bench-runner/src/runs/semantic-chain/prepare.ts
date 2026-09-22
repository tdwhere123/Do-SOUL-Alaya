import { join } from "node:path";
import { SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceSemanticQuery, type SourceSemanticHandleDescriptor } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import { readSemanticChainProposalResults, semanticChainProposalStates } from "./inputs.js";
import { parseSemanticProposalWorkset, SEMANTIC_PROPOSAL_WORKSET_CONTRACT } from "../semantic-proposal/workset.js";
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
      if (plan.input_identity !== inputIdentity) throw new Error("semantic chain preparation inputs changed; use a new stage root");
      materializeCorrespondenceWorkset(plan, root);
      return plan;
    }
    const queries: SemanticChainPlan["queries"] = [];
    const items: unknown[] = [];
    const prepare = async (daemon?: BenchDaemonHandle) => {
      for (const row of results) {
        const base = { query_key: row.line.key, original_query: row.line.original_query, raw_digest: row.shard?.raw_digest ?? null };
        const querySemantics = row.received !== undefined && "query" in row.received ? row.received.query : undefined;
        if (querySemantics === undefined) { queries.push({ ...base, status: "blocked", reason: row.status }); continue; }
        let found;
        try { found = await discover(daemon!, config, row.line.original_query, querySemantics); }
        catch (error) { queries.push({ ...base, status: "blocked", reason: `discovery_unavailable: ${error instanceof Error ? error.message : String(error)}` }); continue; }
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
    if (results.some((row) => row.received !== undefined)) await withSemanticChainDaemon(config, root, prepare);
    else await prepare();
    const workset = items.length === 0 ? null : parseSemanticProposalWorkset({
      contract: SEMANTIC_PROPOSAL_WORKSET_CONTRACT, kind: "semantic_correspondence", model: config.query_workset.model,
      request_profile: config.query_workset.request_profile, items
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

async function discover(daemon: BenchDaemonHandle, config: SemanticChainConfig, original: string, querySemantics: SourceSemanticQuery) {
  const descriptors: SourceSemanticHandleDescriptor[] = [];
  const seen = new Set<string>();
  const handles = new Set<string>();
  const trace = [];
  let continuation: string | undefined;
  let pages = 0, open = false, remainingDescriptors = 0;
  let unvisitedInterpretations = false;
  let poolId: string | undefined;
  do {
    const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: original, query_semantics: querySemantics,
        budget: config.budget, authorized_scopes: config.authorized_scopes, access_policy: config.access_policy,
        ...(continuation === undefined ? {} : { continuation_handle: continuation }) })));
    if (response.operation !== "prepare_query") throw new Error("native discovery returned a different operation");
    const access = response.access;
    if (access === undefined || access.policy !== config.access_policy || access.trace.kind !== "preparation_page") {
      throw new Error("native discovery did not bind the frozen access policy");
    }
    if ((poolId !== undefined && access.pool_id !== poolId) || access.trace.interpretation_offset !== descriptors.length) {
      throw new Error("native discovery changed its bound candidate pool or offset");
    }
    poolId = access.pool_id;
    trace.push({ coverage: response.coverage, work: response.work, access, continuation_handle: response.continuation_handle ?? null,
      candidate_ids: response.candidates.map((candidate) => candidate.interpretation_id) });
    pages++;
    open = response.coverage.discovery !== "complete" || access.unvisited_sources || access.unvisited_interpretations;
    unvisitedInterpretations = access.unvisited_interpretations;
    remainingDescriptors = access.observed_interpretation_count - access.trace.interpretation_offset - response.candidates.length;
    if (remainingDescriptors < 0) throw new Error("native discovery exceeded its observed candidate pool");
    for (const descriptor of response.candidates) {
      if (seen.has(descriptor.interpretation_id)) throw new Error("native discovery repeated a candidate");
      seen.add(descriptor.interpretation_id); descriptors.push(descriptor);
    }
    continuation = response.continuation_handle;
    if (continuation !== undefined && handles.has(continuation)) throw new Error("native discovery continuation did not advance");
    if (continuation !== undefined) handles.add(continuation);
    // Source trace pagination does not create another correspondence opportunity.
  } while (remainingDescriptors > 0 && continuation !== undefined && pages < config.discovery_page_cap);
  return { descriptors, discovery_trace: trace, discovery_pages: pages, discovery_open: open || remainingDescriptors > 0,
    discovery_truncated: open || remainingDescriptors > 0,
    unvisited_source_interpretation_count: unvisitedInterpretations ? null : 0 };
}
