import { join, resolve } from "node:path";
import { AlayaError, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  canonicalJson } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { readSemanticChainProposalResults } from "./inputs.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, withSemanticChainDaemon,
  writeChainArtifact } from "./contract.js";
import { parseSemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { admitInitialQualified, initialSourcePhysicalOwner } from "./recovery-publication.js";
import { reserveRecoveryEffect } from "./recovery-window.js";
import { SourceSemanticReasoningResultSchema } from "@do-soul/alaya-protocol";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { readCompleteRetainedSourceResponse } from "../extraction/cache/source-interactive-binding.js";
import { reserveRecoveryRead, reserveRecoveryAction, reserveRecoveryHostEffect,
  recordRecoveryNativeWork } from "./recovery-allowance.js";

function recoveryNomination(root: string, reason: { identity?: string; qualified_snapshot_identity?: string;
  results?: { source_interpretation_id?: string; status?: string; response?: { result?: unknown } }[] }) {
  const { window, settled } = admitInitialQualified(root);
  if (reason.qualified_snapshot_identity !== settled.publication_identity || !Array.isArray(reason.results)) {
    throw new AlayaError("CONFLICT", "source nomination lacks the settled initial reasoning round");
  }
  const candidates = reason.results.flatMap(row => {
    if (row.status !== "reasoned" || row.response?.result === undefined) return [];
    const result = SourceSemanticReasoningResultSchema.parse(row.response.result);
    const attention = result.attention;
    if (attention?.kind !== "computed" || attention.entries.length === 0 || attention.truncated ||
        attention.source_interpretation_id !== row.source_interpretation_id ||
        attention.conditional_computation_id !== result.conditional_computation_id ||
        attention.query_semantics_id !== result.query_semantics_id ||
        attention.semantic_correspondence_id !== result.semantic_correspondence_id) return [];
    const source = window.window.find(source => source.source_id === attention.source_id &&
      source.source_version === attention.source_version && source.content_digest === attention.content_digest);
    return source === undefined ? [] : [{ source, attention }];
  });
  const nominated = candidates.find(row => !row.source.complete) ?? candidates[0];
  const eligible = window.window.filter(source => {
    if (settled.descriptor_export.some(row => row.source_id === source.source_id &&
        row.source_version === source.source_version && row.record_id === source.record_id)) return true;
    try {
      if (source.initial_key === null) return false;
      const physical = initialSourcePhysicalOwner(settled, source.initial_key);
      const preflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
        path: physical.preflightPath, maxBytes: 32 * 1024 * 1024, label: "initial H parent preflight" })));
      const parent = preflight.ready_requests.find(row => row.key === source.initial_key);
      if (parent === undefined) return false;
      readCompleteRetainedSourceResponse({ cacheRoot: physical.cacheRoot, preflight, line: parent });
      return true;
    } catch { return false; }
  });
  const chosen = nominated ?? (() => {
    const source = eligible.find(row => !row.complete) ?? eligible[0];
    return source === undefined ? undefined : { source, attention: null };
  })();
  if (chosen === undefined) throw new AlayaError("CONFLICT", "no frozen source has a qualified H or complete physical H parent");
  return { contract: "source-semantic-recovery-nomination-v1", reason_identity: reason.identity,
    qualified_snapshot_identity: settled.publication_identity,
    source_id: chosen.source.source_id, source_version: chosen.source.source_version,
    record_id: chosen.source.record_id, content_digest: chosen.source.content_digest,
    initial_read_bytes: chosen.source.read_bytes, initial_body_bytes: chosen.source.body_bytes,
    attention: chosen.attention,
    nomination: nominated === undefined ? "frozen_window_after_unbound_reason" : "initial_reason_attention" };
}

export function admitRecoveryNomination(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "admit initial source nomination");
  const reason = readChainArtifact(join(root, "initial-reason.json")) as Parameters<typeof recoveryNomination>[1] | undefined;
  if (reason === undefined) throw new AlayaError("CONFLICT", "source nomination has no completed initial reason");
  const expected = recoveryNomination(root, reason);
  const retained = readChainArtifact(join(root, "source-nomination.json"));
  if (retained === undefined || canonicalJson(retained) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "retained source nomination changed before correction");
  }
  return expected;
}

/** The first conditional branch runs handleless against the newly qualified sealed SQLite. */
export async function reasonInitialRecovery(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "initial handleless reason inputs");
  const { window, settled } = admitInitialQualified(root);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json")));
  const query = plan.queries[0];
  if (query?.status !== "ready" || plan.queries.length !== 1) {
    throw new AlayaError("CONFLICT", "initial reason requires the frozen admitted original query");
  }
  const expected = settled.descriptor_export.slice(0, plan.config.correspondence_pair_cap);
  const worksetPath = join(root, "initial-correspondence-workset.json");
  const workset = expected.length === 0 ? null : parseSemanticProposalWorkset(JSON.parse(
    readBoundedCanonicalUtf8Artifact({ path: worksetPath, maxBytes: 32 * 1024 * 1024,
      label: "initial correspondence workset" })));
  const binding = readChainArtifact(join(root, "initial-correspondence-binding.json")) as {
    workset_identity?: string | null; query_key?: string; qualified_snapshot_identity?: string;
    source_interpretation_ids?: string[] } | undefined;
  if (binding?.workset_identity !== (workset === null ? null : chainIdentity(workset)) || binding.query_key !== query.query_key ||
      binding.qualified_snapshot_identity !== settled.publication_identity) {
    throw new AlayaError("CONFLICT", "initial C workset lacks its Q/H stage binding");
  }
  if ((workset?.items.length ?? 0) !== expected.length ||
      canonicalJson(binding.source_interpretation_ids) !== canonicalJson(expected.map(row => row.descriptor.source_interpretation_id))) {
    throw new AlayaError("CONFLICT", "initial correspondence denominator changed");
  }
  const cacheRoot = resolve(plan.config.correspondence_cache_root);
  const rows = workset === null ? [] : readSemanticChainProposalResults(workset, cacheRoot,
    plan.config.correspondence_generation?.max_output_tokens ?? plan.config.max_output_tokens);
  const current = rows.map((row, index) => {
    const request = row.line.request;
    const descriptor = expected[index]?.descriptor;
    if (request.contract !== "source-semantic-correspondence-request-v7" ||
        canonicalJson(request.admitted_query_semantics) !== canonicalJson(query.query_semantics) ||
        request.original_query !== query.original_query ||
        request.source_interpretation_descriptors[0]?.source_interpretation_id !== descriptor?.source_interpretation_id) {
      throw new AlayaError("CONFLICT", "initial C no longer binds frozen Q and published H");
    }
    return { row, descriptor };
  });
  const resultPath = join(root, "initial-reason.json");
  const identity = chainIdentity({ window: chainIdentity(window), qualified: settled.publication_identity,
    workset: workset === null ? null : chainIdentity(workset),
    caches: rows.map(row => [row.line.key, row.cache_identity, row.status]) });
  const retained = readChainArtifact(resultPath);
  if (retained !== undefined) {
    if ((retained as { identity?: string }).identity !== identity) throw new AlayaError("CONFLICT", "initial reason inputs changed");
    const expected = recoveryNomination(root, retained as Parameters<typeof recoveryNomination>[1]);
    const priorNomination = readChainArtifact(join(root, "source-nomination.json"));
    if (priorNomination === undefined) writeChainArtifact(join(root, "source-nomination.json"), expected);
    else if (canonicalJson(priorNomination) !== canonicalJson(expected)) {
      throw new AlayaError("CONFLICT", "source nomination changed on reason replay");
    }
    return retained;
  }
  const results: NonNullable<Parameters<typeof recoveryNomination>[1]["results"]> = [];
  const config = { ...plan.config, snapshot_path: settled.snapshot_path, snapshot_sha256: settled.snapshot_sha256 };
  const pending = current.map(({ row, descriptor }, index) => {
    const correspondence = row.received !== undefined && "semantic_correspondence" in row.received
      ? row.received.semantic_correspondence : undefined;
    const callIdentity = chainIdentity({ identity, source_interpretation_id: descriptor!.source_interpretation_id,
      correspondence: correspondence ?? null });
    const prior = readChainArtifact(join(root, `initial-reason-${index}.json`));
    reserveRecoveryAction(root, `initial-native-reason-${index}`, callIdentity,
      config.budget.work_units, config.budget.memory_bytes, prior !== undefined);
    return prior === undefined;
  });
  if (pending.some(Boolean)) {
    reserveRecoveryHostEffect(root, "initial-reason-daemon", identity, false);
  }
  if (pending.some(Boolean)) await withSemanticChainDaemon(config, root, async daemon => {
    for (const [index, { row, descriptor }] of current.entries()) {
      const correspondence = row.received !== undefined && "semantic_correspondence" in row.received
        ? row.received.semantic_correspondence : undefined;
      const slotPath = join(root, `initial-reason-${index}.json`);
      const prior = readChainArtifact(slotPath);
      const callIdentity = chainIdentity({ identity, source_interpretation_id: descriptor!.source_interpretation_id,
        correspondence: correspondence ?? null });
      reserveRecoveryEffect(`${slotPath}.reserved`, callIdentity, prior !== undefined);
      if (prior !== undefined) { results.push(prior as typeof results[number]); continue; }
      const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
        SoulInterpretationRequestSchema.parse({ operation: "reason", original_query: query.original_query,
          query_semantics: query.query_semantics, source_interpretation_id: descriptor!.source_interpretation_id,
          ...(correspondence === undefined ? {} : { semantic_correspondence: correspondence }),
          accepts_unreviewed_conditional_results: true,
          budget: config.budget, output_byte_limit: config.output_byte_limit,
          authorized_scopes: config.authorized_scopes })));
      if (response.operation !== "reason") throw new AlayaError("CONFLICT", "native worker changed reason operation");
      recordRecoveryNativeWork(root, `initial-native-reason-${index}`, response.work);
      const item = { source_interpretation_id: descriptor!.source_interpretation_id,
        status: correspondence === undefined ? "preparation_required" : "reasoned",
        proposal_status: row.status, response };
      writeChainArtifact(slotPath, item);
      results.push(item);
    }
  });
  else for (const [index] of current.entries()) results.push(readChainArtifact(join(root,
    `initial-reason-${index}.json`)) as typeof results[number]);
  const result = { contract: "source-semantic-initial-reason-v1", identity,
    qualified_snapshot_identity: settled.publication_identity,
    status: current.length === 0 ? "not_executed_no_qualified_h" : "reasoned", results };
  writeChainArtifact(resultPath, result);
  writeChainArtifact(join(root, "source-nomination.json"), recoveryNomination(root, result));
  return result;
}
