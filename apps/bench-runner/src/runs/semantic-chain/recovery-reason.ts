import { join, resolve } from "node:path";
import { AlayaError, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  canonicalJson, SourceSemanticCorrespondencePreparationOptionsSchema,
  SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY, sourceSemanticCorrespondenceCacheMaterial,
  sourceSemanticCorrespondenceGenerationPolicies, sourceSemanticQueryIdentity,
  sourceSemanticReasonControl, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { readSemanticChainProposalResults } from "./inputs.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, withSemanticChainDaemon,
  writeChainArtifact } from "./contract.js";
import { parseSemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { admitInitialQualified, initialSourcePhysicalOwner } from "./recovery-publication.js";
import { reserveRecoveryEffect } from "./recovery-window.js";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { inspectOptionalCompleteSourceResponse } from "../extraction/cache/source-interactive-binding.js";
import { reserveRecoveryRead, reserveRecoveryAction, reserveRecoveryHostEffect,
  recordRecoveryNativeWork } from "./recovery-allowance.js";

type RecoveryReasonRound = { identity?: string; qualified_snapshot_identity?: string;
  results?: { source_interpretation_id?: string; status?: string; response?: { result?: unknown } }[] };
type RecoveryWindowSource = ReturnType<typeof admitInitialQualified>["window"]["window"][number];
type RecoveryReasonQuery = Readonly<{ original_query: string; query_semantics: SourceSemanticQuery }>;
type RecoveryReasonSelected = readonly Readonly<{ descriptor: { source_interpretation_id: string; interpretation: unknown } }>[];

/** Q × selected H × protocol policies; full-catalog omits generation_policy bytes. */
export function buildRecoveryReasonCorrespondenceItems(query: RecoveryReasonQuery,
  selected: RecoveryReasonSelected, options: unknown = {}) {
  const policy = SourceSemanticCorrespondencePreparationOptionsSchema.parse(options);
  const policies = sourceSemanticCorrespondenceGenerationPolicies(query.query_semantics, policy.correspondence_demand);
  return selected.flatMap(row => policies.map(generation_policy => ({
    original_query: query.original_query, admitted_query_semantics: query.query_semantics,
    ...(policy.correspondence_demand === undefined ? {} : { generation_policy }),
    source_interpretation_descriptors: [row.descriptor]
  }))).slice(0, policy.correspondence_cap ?? selected.length);
}

function correspondenceCacheMaterial(query: RecoveryReasonQuery, sourceInterpretationId: string,
  generationPolicy: SourceSemanticCorrespondenceRequest["generation_policy"]) {
  return sourceSemanticCorrespondenceCacheMaterial({
    query_semantics_id: sourceSemanticQueryIdentity(query.query_semantics, fieldContractSha256),
    source_interpretation_id: sourceInterpretationId,
    generation_policy: generationPolicy ?? SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY });
}

/** Bind each retained C by H id and policy cache material, not workset index or a v7 contract. */
export function bindRecoveryReasonCorrespondence<T extends Readonly<{ line: { request: unknown } }>>(
  rows: readonly T[], selected: RecoveryReasonSelected, query: RecoveryReasonQuery, options: unknown = {}) {
  const policy = SourceSemanticCorrespondencePreparationOptionsSchema.parse(options);
  const items = buildRecoveryReasonCorrespondenceItems(query, selected, policy);
  if (rows.length !== items.length) throw new AlayaError("CONFLICT", "initial correspondence denominator changed");
  const expected = new Set(items.map(item => correspondenceCacheMaterial(query,
    item.source_interpretation_descriptors[0]!.source_interpretation_id,
    "generation_policy" in item ? item.generation_policy as SourceSemanticCorrespondenceRequest["generation_policy"] : undefined)));
  const seen = new Set<string>();
  return rows.map(row => {
    const request = row.line.request;
    if (typeof request !== "object" || request === null || !("source_interpretation_descriptors" in request) ||
        !("admitted_query_semantics" in request) || !("original_query" in request)) {
      throw new AlayaError("CONFLICT", "initial C no longer binds frozen Q and published H");
    }
    const correspondence = request as SourceSemanticCorrespondenceRequest;
    const source = selected.find(entry => entry.descriptor.source_interpretation_id ===
      correspondence.source_interpretation_descriptors[0]?.source_interpretation_id);
    const material = source === undefined ? undefined : correspondenceCacheMaterial(query,
      source.descriptor.source_interpretation_id, correspondence.generation_policy);
    if (source === undefined || material === undefined || !expected.has(material) || seen.has(material) ||
        canonicalJson(correspondence.admitted_query_semantics) !== canonicalJson(query.query_semantics) ||
        correspondence.original_query !== query.original_query ||
        (correspondence.generation_policy === undefined) !== (policy.correspondence_demand === undefined)) {
      throw new AlayaError("CONFLICT", "initial C no longer binds frozen Q and published H");
    }
    seen.add(material);
    return { row, descriptor: source.descriptor };
  });
}

/** Attention first, then eligible frozen order; physical-parent eligibility is supplied by the caller. */
export function selectRecoveryNomination(window: readonly RecoveryWindowSource[],
  qualifiedSnapshotIdentity: string, reason: RecoveryReasonRound,
  eligible: readonly RecoveryWindowSource[]) {
  if (!Array.isArray(reason.results)) {
    throw new AlayaError("CONFLICT", "source nomination lacks the settled initial reasoning round");
  }
  const controls = reason.results.flatMap(row => row.response === undefined ? []
    : [{ row, control: sourceSemanticReasonControl(row.response) }]);
  const candidates = controls.flatMap(({ row, control: result }) => {
    if (row.status !== "reasoned") return [];
    const attention = result.attention;
    if (attention?.kind !== "computed" || attention.entries.length === 0 || attention.truncated ||
        attention.source_interpretation_id !== row.source_interpretation_id ||
        attention.conditional_computation_id !== result.conditional_computation_id ||
        attention.query_semantics_id !== result.query_semantics_id ||
        attention.semantic_correspondence_id !== result.semantic_correspondence_id) return [];
    const source = window.find(source => source.source_id === attention.source_id &&
      source.source_version === attention.source_version && source.content_digest === attention.content_digest);
    return source === undefined ? [] : [{ source, attention }];
  });
  const nominated = candidates.find(row => !row.source.complete) ?? candidates[0];
  const chosen = nominated ?? (() => {
    const source = eligible.find(row => !row.complete) ?? eligible[0];
    return source === undefined ? undefined : { source, attention: null };
  })();
  if (chosen === undefined) throw new AlayaError("CONFLICT", "no frozen source has a qualified H or complete physical H parent");
  return { contract: "source-semantic-recovery-nomination-v1", reason_identity: reason.identity,
    qualified_snapshot_identity: qualifiedSnapshotIdentity,
    source_id: chosen.source.source_id, source_version: chosen.source.source_version,
    record_id: chosen.source.record_id, content_digest: chosen.source.content_digest,
    initial_read_bytes: chosen.source.read_bytes, initial_body_bytes: chosen.source.body_bytes,
    attention: chosen.attention,
    reason_controls: controls.map(({ row, control }) => ({
      source_interpretation_id: control.source_interpretation_id ?? row.source_interpretation_id,
      query_semantics_id: control.query_semantics_id, semantic_correspondence_id: control.semantic_correspondence_id,
      conditional_computation_id: control.conditional_computation_id, outcome: control.outcome,
      source_target: control.source_target, query_gaps: control.query_gaps })),
    nomination: nominated !== undefined ? "initial_reason_attention"
      : controls.some(({ control }) => control.conditional_computation_id !== undefined)
        ? "frozen_window_after_computed_reason" : "frozen_window_after_unbound_reason" };
}

type RecoveryQualified = ReturnType<typeof admitInitialQualified>["settled"];

/** Physical-parent eligibility then frozen-window policy. Verified absence is ineligible; reads stay errors. */
export function nominateRecoverySource(window: readonly RecoveryWindowSource[], settled: RecoveryQualified,
  reason: RecoveryReasonRound) {
  if (reason.qualified_snapshot_identity !== settled.publication_identity || !Array.isArray(reason.results)) {
    throw new AlayaError("CONFLICT", "source nomination lacks the settled initial reasoning round");
  }
  const eligible = window.filter(source => {
    if (settled.descriptor_export.some(row => row.source_id === source.source_id &&
        row.source_version === source.source_version && row.record_id === source.record_id)) return true;
    if (source.initial_key === null || !settled.source_owners.some(row => row.key === source.initial_key)) {
      return false;
    }
    const physical = initialSourcePhysicalOwner(settled, source.initial_key);
    const preflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: physical.preflightPath, maxBytes: 32 * 1024 * 1024, label: "initial H parent preflight" })));
    const parent = preflight.ready_requests.find(row => row.key === source.initial_key);
    if (parent === undefined) return false;
    return inspectOptionalCompleteSourceResponse({ cacheRoot: physical.cacheRoot, preflight, line: parent })
      .status === "complete";
  });
  return selectRecoveryNomination(window, settled.publication_identity, reason, eligible);
}

function recoveryNomination(root: string, reason: RecoveryReasonRound) {
  const { window, settled } = admitInitialQualified(root);
  return nominateRecoverySource(window.window, settled, reason);
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
  const selected = settled.descriptor_export.slice(0, plan.config.correspondence_pair_cap);
  const preparation = { correspondence_demand: plan.config.correspondence_demand,
    correspondence_cap: plan.config.correspondence_cap };
  const items = buildRecoveryReasonCorrespondenceItems(query, selected, preparation);
  const worksetPath = join(root, "initial-correspondence-workset.json");
  const workset = items.length === 0 ? null : parseSemanticProposalWorkset(JSON.parse(
    readBoundedCanonicalUtf8Artifact({ path: worksetPath, maxBytes: 32 * 1024 * 1024,
      label: "initial correspondence workset" })));
  const binding = readChainArtifact(join(root, "initial-correspondence-binding.json")) as {
    workset_identity?: string | null; query_key?: string; qualified_snapshot_identity?: string;
    source_interpretation_ids?: string[] } | undefined;
  if (binding?.workset_identity !== (workset === null ? null : chainIdentity(workset)) || binding.query_key !== query.query_key ||
      binding.qualified_snapshot_identity !== settled.publication_identity) {
    throw new AlayaError("CONFLICT", "initial C workset lacks its Q/H stage binding");
  }
  if ((workset === null ? 0 : workset.items.length) !== items.length ||
      (workset !== null && canonicalJson(workset.items) !== canonicalJson(items)) ||
      canonicalJson(binding.source_interpretation_ids) !== canonicalJson(selected.map(row => row.descriptor.source_interpretation_id))) {
    throw new AlayaError("CONFLICT", "initial correspondence denominator changed");
  }
  const cacheRoot = resolve(plan.config.correspondence_cache_root);
  const rows = workset === null ? [] : readSemanticChainProposalResults(workset, cacheRoot,
    plan.config.correspondence_generation?.max_output_tokens ?? plan.config.max_output_tokens);
  const current = bindRecoveryReasonCorrespondence(rows, selected, query, preparation);
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
    const callIdentity = chainIdentity({ identity, source_interpretation_id: descriptor.source_interpretation_id,
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
      const callIdentity = chainIdentity({ identity, source_interpretation_id: descriptor.source_interpretation_id,
        correspondence: correspondence ?? null });
      reserveRecoveryEffect(`${slotPath}.reserved`, callIdentity, prior !== undefined);
      if (prior !== undefined) { results.push(prior as typeof results[number]); continue; }
      const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
        SoulInterpretationRequestSchema.parse({ operation: "reason", original_query: query.original_query,
          query_semantics: query.query_semantics, source_interpretation_id: descriptor.source_interpretation_id,
          ...(correspondence === undefined ? {} : { semantic_correspondence: correspondence }),
          accepts_unreviewed_conditional_results: true,
          budget: config.budget, output_byte_limit: config.output_byte_limit,
          authorized_scopes: config.authorized_scopes })));
      if (response.operation !== "reason") throw new AlayaError("CONFLICT", "native worker changed reason operation");
      recordRecoveryNativeWork(root, `initial-native-reason-${index}`, response.work);
      const item = { source_interpretation_id: descriptor.source_interpretation_id,
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
