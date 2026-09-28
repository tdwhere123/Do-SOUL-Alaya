import { join } from "node:path";
import { AlayaError, canonicalJson, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceSemanticQuery, type SourceSemanticQueryUnavailableReason, type SourceSemanticHandleDescriptor } from "@do-soul/alaya-protocol";
import { admitSourceSemanticQuery, sourceSemanticQueryStatus } from "@do-soul/alaya-core";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import { readSemanticChainProposalResults, semanticChainPreparationIdentity, semanticChainQueryAvailability,
  verifySemanticChainQueries } from "./inputs.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset, semanticProposalWorksetContract,
  type SemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { SemanticChainConfigSchema, SemanticChainPlanSchema, SEMANTIC_CHAIN_PLAN_CONTRACT, chainIdentity, readChainArtifact, writeChainArtifact,
  writeChainJson, assertChainSnapshot, withSemanticChainDaemon, type SemanticChainConfig, type SemanticChainPlan } from "./contract.js";

export async function prepareSemanticChain(value: unknown, root: string,
  liveDaemon?: BenchDaemonHandle, onLiveHandles?: (handles: ReadonlyMap<string, string | undefined>) => void,
  settledCorrespondenceWorkset?: SemanticProposalWorkset | null,
  settledSelection: "strict" | "observed_subset" = "strict"
): Promise<SemanticChainPlan> {
  const config = SemanticChainConfigSchema.parse(value);
  assertChainSnapshot(config);
  if (settledSelection === "observed_subset" && settledCorrespondenceWorkset === undefined) {
    throw new AlayaError("CONFLICT", "observed C subset requires an explicit settled input");
  }
  const results = readSemanticChainProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens);
  const settledInput = settledSelection === "observed_subset" ? { selection: settledSelection,
    full_workset_identity: settledCorrespondenceWorkset === null ? null :
      chainIdentity(settledCorrespondenceWorkset) } : undefined;
  const inputIdentity = semanticChainPreparationIdentity(config, results, settledInput);
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
    const liveHandles = new Map<string, string | undefined>();
    const prepare = async (daemon?: BenchDaemonHandle) => {
      for (const row of results) {
        const base = { query_key: row.line.key, original_query: row.line.original_query, raw_digest: row.shard?.raw_digest ?? null };
        const availability = semanticChainQueryAvailability(row);
        const querySemantics = availability.status === "admitted" ? availability.query : undefined;
        const unavailable = availability.status === "unavailable" && availability.unavailable !== "absent"
          ? availability.unavailable : undefined;
        let found;
        const discoveryStarted = performance.now();
        try {
          const observed = await discoverSemanticChainQuery(daemon!, config, row.line.original_query, querySemantics, unavailable);
          found = observed.discovery;
          liveHandles.set(row.line.key, observed.query_handle);
        }
        catch (error) {
          if (!(error instanceof AlayaError && error.code === "UNAVAILABLE")) throw error;
          queries.push({ ...base, status: "blocked", reason: `discovery_unavailable: ${error.message}` });
          continue;
        }
        if (querySemantics === undefined) {
          if (availability.status !== "unavailable") throw new AlayaError("INTERNAL", "raw query availability changed");
          queries.push({ ...base, status: "raw_ready", reason: availability.reason,
            query_semantics_unavailable: availability.unavailable, ...found,
            initial_discovery_elapsed_ms: performance.now() - discoveryStarted });
          continue;
        }
        const selected = found.descriptors.filter((descriptor) => descriptor.interpretation !== undefined).slice(0, config.correspondence_pair_cap);
        queries.push({ ...base, status: "ready", query_semantics: querySemantics, ...found,
          initial_discovery_elapsed_ms: performance.now() - discoveryStarted,
          selected_source_interpretation_ids: selected.map((entry) => entry.interpretation_id),
          correspondence_opportunities: found.descriptors.map((descriptor) => ({ source_interpretation_id: descriptor.interpretation_id,
            decision: descriptor.interpretation === undefined ? "missing_interpretation" : config.correspondence_pair_cap === 0
              ? "zero_budget" : selected.includes(descriptor) ? "selected" : "not_selected" })) });
        for (const descriptor of selected) items.push({ original_query: row.line.original_query, admitted_query_semantics: querySemantics,
          source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: descriptor.interpretation }] });
      }
    };
    if (liveDaemon === undefined) await withSemanticChainDaemon(config, root, prepare);
    else await prepare(liveDaemon);
    const cGeneration = config.correspondence_generation ?? {
      model: config.query_workset.model, request_profile: config.query_workset.request_profile,
      provider_url: config.query_workset.provider_url
    };
    const generated = items.length === 0 ? null : parseSemanticProposalWorkset({
      contract: semanticProposalWorksetContract(cGeneration.request_profile), kind: "semantic_correspondence", model: cGeneration.model,
      request_profile: cGeneration.request_profile, provider_url: cGeneration.provider_url, items
    });
    let workset = settledCorrespondenceWorkset === undefined ? generated : settledCorrespondenceWorkset;
    if (settledSelection === "observed_subset") {
      if (queries.length !== 1 || queries[0]?.status !== "ready") {
        throw new AlayaError("CONFLICT", "observed C subset requires one settled native query");
      }
      workset = selectObservedSettledCorrespondence(workset, queries[0], config.correspondence_pair_cap,
        config.correspondence_generation?.max_output_tokens ?? config.max_output_tokens).workset;
    }
    if (settledCorrespondenceWorkset !== undefined && workset !== null) {
      if (queries.length !== 1 || queries[0]?.status !== "ready" ||
          workset.kind !== "semantic_correspondence" ||
          workset.model !== cGeneration.model || workset.request_profile !== cGeneration.request_profile ||
          workset.provider_url !== cGeneration.provider_url ||
          workset.items.length > config.correspondence_pair_cap) {
        throw new AlayaError("CONFLICT", "settled C workset changed final native query or producer setting");
      }
      const query = queries[0];
      const seen = new Set<string>();
      for (const line of materializeSemanticProposalLines(workset, config.correspondence_generation?.max_output_tokens ?? config.max_output_tokens)) {
        if (line.kind !== "semantic_correspondence") {
          throw new AlayaError("CONFLICT", "settled C workset changed request kind");
        }
        const request = line.request as SourceSemanticCorrespondenceRequest;
        const descriptor = request.source_interpretation_descriptors[0];
        const native = query.descriptors.find(row => row.interpretation_id === descriptor?.source_interpretation_id);
        if (request.original_query !== query.original_query ||
            canonicalJson(request.admitted_query_semantics) !== canonicalJson(query.query_semantics) ||
            native === undefined || canonicalJson(descriptor?.interpretation) !== canonicalJson(native.interpretation) ||
            seen.has(native.interpretation_id)) {
          throw new AlayaError("CONFLICT", "settled C request does not bind a distinct current native H descriptor");
        }
        seen.add(native.interpretation_id);
      }
    }
    const plan = SemanticChainPlanSchema.parse({ contract: SEMANTIC_CHAIN_PLAN_CONTRACT, input_identity: inputIdentity,
      config, queries, correspondence_workset: workset,
      ...(settledInput === undefined ? {} : { settled_input: settledInput }) });
    writeChainArtifact(path, plan);
    materializeCorrespondenceWorkset(plan, root);
    onLiveHandles?.(liveHandles);
    return plan;
  });
}

/** Native preparation owns the observed subset; publication may contain H beyond preview extents. */
export function selectObservedSettledCorrespondence(full: SemanticProposalWorkset | null,
  query: SemanticChainPlan["queries"][number], pairCap: number, outputCap: number) {
  if (query.status !== "ready") throw new AlayaError("CONFLICT", "observed C subset requires an admitted query");
  const observed = new Map(query.descriptors.filter(row => row.interpretation !== undefined)
    .map(row => [row.interpretation_id, row]));
  if (full === null) return { workset: null, unobserved_ids: [] as string[] };
  if (full.items.length > pairCap) throw new AlayaError("CONFLICT", "settled C exceeds the frozen correspondence cap");
  const lines = materializeSemanticProposalLines(full, outputCap);
  const unobserved: string[] = [];
  const items = full.items.filter((_item, index) => {
    const request = lines[index]?.request as SourceSemanticCorrespondenceRequest | undefined;
    const descriptor = request?.source_interpretation_descriptors[0];
    if (request?.original_query !== query.original_query ||
        canonicalJson(request?.admitted_query_semantics) !== canonicalJson(query.query_semantics) ||
        descriptor === undefined) {
      throw new AlayaError("CONFLICT", "settled C changed the admitted native Q");
    }
    const native = observed.get(descriptor.source_interpretation_id);
    if (native === undefined) {
      unobserved.push(descriptor.source_interpretation_id);
      return false;
    }
    if (canonicalJson(descriptor.interpretation) !== canonicalJson(native.interpretation)) {
      throw new AlayaError("CONFLICT", "settled C changed the observed native H");
    }
    return true;
  });
  return { workset: items.length === 0 ? null : parseSemanticProposalWorkset({ ...full, items }),
    unobserved_ids: unobserved };
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
        ...(config.source_preview_extents === undefined ? {} : { source_preview_extents: config.source_preview_extents }),
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
