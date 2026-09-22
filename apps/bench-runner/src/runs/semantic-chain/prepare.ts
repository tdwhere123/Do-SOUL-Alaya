import { join } from "node:path";
import { SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceSemanticQuery, type SourceSemanticHandleDescriptor } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import { readSemanticProposalResults } from "../semantic-proposal/fill.js";
import { parseSemanticProposalWorkset, SEMANTIC_PROPOSAL_WORKSET_CONTRACT } from "../semantic-proposal/workset.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { SemanticChainConfigSchema, SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainArtifact,
  writeChainJson, assertChainSnapshot, withSemanticChainDaemon, type SemanticChainConfig, type SemanticChainPlan } from "./contract.js";

export async function prepareSemanticChain(value: unknown, root: string): Promise<SemanticChainPlan> {
  const config = SemanticChainConfigSchema.parse(value);
  assertChainSnapshot(config);
  const results = readSemanticProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens);
  const inputIdentity = chainIdentity({ config, queries: results.map((row) => ({
    key: row.line.key, raw: row.shard?.raw_digest ?? null, status: row.status
  })) });
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
    let remaining = config.correspondence_pair_cap;
    const prepare = async (daemon?: BenchDaemonHandle) => {
      for (const row of results) {
        const base = { query_key: row.line.key, original_query: row.line.original_query, raw_digest: row.shard?.raw_digest ?? null };
        const q = row.received !== undefined && "query" in row.received ? row.received.query : undefined;
        if (q === undefined) { queries.push({ ...base, status: "blocked", reason: row.status }); continue; }
        const found = await discover(daemon!, config, row.line.original_query, q);
        const selected = found.descriptors.filter((descriptor) => descriptor.interpretation !== undefined).slice(0, remaining);
        remaining -= selected.length;
        queries.push({ ...base, status: "ready", query_semantics: q, ...found, selected_source_interpretation_ids: selected.map((entry) => entry.interpretation_id) });
        for (const descriptor of selected) items.push({ original_query: row.line.original_query, admitted_query_semantics: q,
          source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: descriptor.interpretation }] });
      }
    };
    if (results.some((row) => row.received !== undefined)) await withSemanticChainDaemon(config, root, prepare);
    else await prepare();
    const workset = items.length === 0 ? null : parseSemanticProposalWorkset({
      contract: SEMANTIC_PROPOSAL_WORKSET_CONTRACT, kind: "semantic_correspondence", model: config.query_workset.model,
      request_profile: config.query_workset.request_profile, items
    });
    const plan = SemanticChainPlanSchema.parse({ contract: "source-semantic-chain-plan-v2", input_identity: inputIdentity,
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

async function discover(daemon: BenchDaemonHandle, config: SemanticChainConfig, original: string, q: SourceSemanticQuery) {
  const descriptors: SourceSemanticHandleDescriptor[] = [];
  const seen = new Set<string>();
  const handles = new Set<string>();
  let continuation: string | undefined;
  let pages = 0, open = false, truncated = false;
  do {
    const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: original, query_semantics: q,
        budget: config.budget, authorized_scopes: config.authorized_scopes,
        ...(continuation === undefined ? {} : { continuation_handle: continuation }) })));
    if (response.operation !== "prepare_query") throw new Error("native discovery returned a different operation");
    pages++;
    open = response.coverage.discovery !== "complete";
    truncated ||= response.truncated;
    for (const descriptor of response.candidates) {
      if (seen.has(descriptor.interpretation_id)) continue;
      seen.add(descriptor.interpretation_id); descriptors.push(descriptor);
    }
    continuation = response.continuation_handle;
    if (continuation !== undefined && handles.has(continuation)) throw new Error("native discovery continuation did not advance");
    if (continuation !== undefined) handles.add(continuation);
  } while (continuation !== undefined && pages < config.discovery_page_cap);
  return { descriptors, discovery_pages: pages, discovery_open: open || continuation !== undefined,
    discovery_truncated: truncated || continuation !== undefined, unvisited_source_interpretation_count: null };
}
