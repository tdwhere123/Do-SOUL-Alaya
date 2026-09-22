import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT,
  type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { hashSourceRecordId, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT, SourceSemanticAccessPolicySchema } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { BENCH_DAEMON_DB_FILENAME } from "../../../runs/snapshot/materialize.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset, materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { prepareSemanticChain, discoverSemanticChainQuery } from "../../../runs/semantic-chain/prepare.js";
import { replaySemanticChain, measureSemanticChain } from "../../../runs/semantic-chain/replay.js";
import { interveneSemanticChain } from "../../../runs/semantic-chain/intervene.js";
import { readChainArtifact, writeChainArtifact, withSemanticChainDaemon, type SemanticChainPlan } from "../../../runs/semantic-chain/contract.js";
import { SemanticChainConfigSchema } from "../../../runs/semantic-chain/contract.js";
import { assertPerQueryOpportunity } from "./native-semantic-arm.test-support.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";

export async function assertNativeSemanticChain(cacheRoot: string, sourceOnlySnapshot: { snapshot_path: string; db_sha256: string }): Promise<void> {
  const queryWorkset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v2",
    kind: "query", model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1",
    items: [{ original_query: "What was completed?" }, { original_query: "What else was completed?" }] });
  const queryCache = join(cacheRoot, "queries"), correspondenceCache = join(cacheRoot, "semantic_correspondences");
  const config = { snapshot_path: join(cacheRoot, "published.sqlite"),
    snapshot_sha256: hashRegularFileNoFollow(join(cacheRoot, "published.sqlite")),
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-21T01:00:00.000Z",
    workspace_id: "source-semantic-library", run_id: "source-semantic-library-run",
    query_workset: queryWorkset, query_cache_root: queryCache, correspondence_cache_root: correspondenceCache,
    max_output_tokens: 4096, discovery_page_cap: 4, correspondence_pair_cap: 1,
    access_policy: SourceSemanticAccessPolicySchema.enum["canonical-v1"],
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 60000000,
      page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 },
    authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 100000 };
  expect(SemanticChainConfigSchema.safeParse({ ...config, access_policy: undefined }).success).toBe(false);
  const blockedRoot = join(cacheRoot, "blocked-chain");
  const blocked = await prepareSemanticChain(config, blockedRoot);
  expect(blocked.queries.every((row) => row.status === "blocked")).toBe(true);
  expect(blocked.correspondence_workset).toBeNull();
  expect(existsSync(join(blockedRoot, "semantic_correspondence-workset.json"))).toBe(false);
  const blockedReplay = await replaySemanticChain(blockedRoot);
  const blockedWithdrawal = interveneSemanticChain(blockedRoot, blockedReplay.path);
  expect((readChainArtifact(blockedWithdrawal.path) as { rows: { status: string }[] }).rows
    .every((row) => row.status === "not_exercised")).toBe(true);
  expect(blockedReplay.result).toMatchObject({ provider_calls: 0, rows: [{ status: "blocked" }, { status: "blocked" }] });
  expect(() => measureSemanticChain(blockedRoot, blockedReplay.path, [])).toThrow(/per-query gold/u);
  const measured = measureSemanticChain(blockedRoot, blockedReplay.path,
    blocked.queries.map((row) => ({ query_key: row.query_key, source_units: [] })));
  expect(measured.result.rows.every((row) => row.measurement === null)).toBe(true);

  const oneQuery = { ...queryWorkset, items: queryWorkset.items.slice(0, 1) };
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(oneQuery, queryCache, 4096),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  const fill = await executeSemanticProposalFill({ workset: oneQuery, cacheRoot: queryCache, authority,
    config: { providerUrl: "http://127.0.0.1:9", model: queryWorkset.model,
      requestProfile: "gemini-2.5-nonthinking-v1", apiKey: "fixture" }, extractor: { extract: async () => ({
      rawJson: JSON.stringify({ contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "interpreted" },
        query: { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, alternatives: [{ conditions: [{
          kind: "statement", key: "complete", predicate: "complete",
          arguments: [{ role: "theme", target: { kind: "free", key: "theme" }, excerpt: "What" }]
        }] }], return: ["theme"], gaps: [] } }), responseMetadata: { finishReason: "STOP" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    }) } });
  expect(fill.newly_admitted).toBe(1);
  await expect(replaySemanticChain(blockedRoot)).rejects.toThrow(/query-semantics state changed/u);
  const limitedRoot = join(cacheRoot, "limited-observation-chain");
  const limited = await prepareSemanticChain({ ...config,
    budget: { ...config.budget, work_units: 200000, memory_bytes: 20000000 }
  }, limitedRoot);
  expect(limited.queries[0]).toMatchObject({ status: "ready", discovery_open: true,
    discovery_truncated: true, unvisited_source_interpretation_count: null,
    discovery_trace: [{ access: { unvisited_interpretations: true, stopping_reasons: ["budget"] } }] });
  if (limited.queries[0]?.status === "ready") expect(limited.queries[0].descriptors.length).toBeLessThan(18);
  await assertReplayPreparationPool(limited, limitedRoot);
  const root = join(cacheRoot, "native-chain");
  const plan = await prepareSemanticChain(config, root);
  await expect(prepareSemanticChain({ ...config, access_policy: "query-conditioned-v1" }, root)).rejects.toThrow(/preparation inputs changed/u);
  const ready = plan.queries.find((row) => row.status === "ready");
  if (ready?.status !== "ready") throw new Error("query fixture was not admitted");
  expect(ready.descriptors).toHaveLength(18);
  expect(ready.discovery_pages).toBe(2);
  expect(ready.discovery_trace.every((page) => page.access.policy === "canonical-v1")).toBe(true);
  expect(new Set(ready.discovery_trace.map((page) => page.access.pool_id)).size).toBe(1);
  expect(ready.selected_source_interpretation_ids).toHaveLength(1);
  expect(plan.correspondence_workset?.items).toHaveLength(1);
  const capped = await prepareSemanticChain({ ...config, discovery_page_cap: 1 }, join(cacheRoot, "capped-chain"));
  expect(capped.queries[0]).toMatchObject({ status: "ready", discovery_pages: 1, discovery_open: true,
    discovery_truncated: true, unvisited_source_interpretation_count: 0 });
  if (capped.queries[0]?.status === "ready") expect(capped.queries[0].descriptors).toHaveLength(16);
  const traceRoot = join(cacheRoot, "source-trace-chain");
  const sourceOnly = await prepareSemanticChain({ ...config, snapshot_path: sourceOnlySnapshot.snapshot_path,
    snapshot_sha256: sourceOnlySnapshot.db_sha256 }, traceRoot);
  expect(sourceOnly.queries[0]).toMatchObject({ status: "ready", discovery_pages: 1, discovery_open: false,
    discovery_truncated: false, descriptors: [], unvisited_source_interpretation_count: 0,
    discovery_trace: [{ access: { observed_source_count: 18, observed_interpretation_count: 0,
      unvisited_sources: false, unvisited_interpretations: false,
      trace: { kind: "preparation_page", source_offset: 0, omitted_source_count: 2 } } }] });
  if (sourceOnly.queries[0]?.status === "ready") expect(sourceOnly.queries[0].discovery_trace[0]?.continuation_handle).not.toBeNull();
  const sourceReplay = await replaySemanticChain(traceRoot);
  const sourcePayload = readChainArtifact(sourceReplay.path) as { rows: { response?: unknown }[] };
  const sourceResponse = SoulInterpretationResponseSchema.parse(sourcePayload.rows[0]?.response);
  if (sourceResponse.operation !== "recall") throw new Error("source-only recall required");
  expect(sourceResponse.discovery?.access).toMatchObject({ policy: "canonical-v1", observed_source_count: 18 });
  expect(sourceResponse.results?.length).toBeGreaterThan(0);
  expect(sourceResponse.proofs ?? []).toHaveLength(0);
  unlinkSync(join(root, "semantic_correspondence-workset.json"));
  expect(await prepareSemanticChain(config, root)).toEqual(plan);
  expect(existsSync(join(root, "semantic_correspondence-workset.json"))).toBe(true);
  const replay = await replaySemanticChain(root);
  const payload = readChainArtifact(replay.path) as { rows: { response?: { index?: { as_of: string } }; correspondence_outcomes?: { status: string }[] }[] };
  expect(payload.rows[0]?.correspondence_outcomes?.every((row) => row.status === "unattempted")).toBe(true);
  expect(payload.rows[0]?.response?.index?.as_of).toBe(config.interpretation_clock);
  expect(await replaySemanticChain(root)).toEqual(replay);
  const withdrawn = await replaySemanticChain(root, "without_semantic_correspondences");
  expect(withdrawn.result).toMatchObject({ arm: "without_semantic_correspondences", provider_calls: 0 });
  const workset = plan.correspondence_workset!;
  const request = materializeSemanticProposalLines(workset, 4096)[0]!.request as SourceSemanticCorrespondenceRequest;
  const sourceInterpretation = request.source_interpretation_descriptors[0]!.interpretation;
  const predicate = request.catalog!.query_endpoints.find((row) => row.kind === "predicate")!;
  const slot = request.catalog!.query_endpoints.find((row) => row.kind === "slot")!;
  const frame = request.catalog!.source_endpoints.find((row) => row.kind === "frame")!;
  const sourceSlot = request.catalog!.source_endpoints.find((row) => row.kind === "slot")!;
  const support = sourceInterpretation.frames[0]!.predicate_support;
  const correspondenceAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, correspondenceCache, 4096),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  const aligned = await executeSemanticProposalFill({ workset, cacheRoot: correspondenceCache, authority: correspondenceAuthority,
    config: { providerUrl: "http://127.0.0.1:9", model: workset.model,
      requestProfile: "gemini-2.5-nonthinking-v1", apiKey: "fixture" }, extractor: { extract: async () => ({
      rawJson: JSON.stringify({ contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT, outcome: { status: "interpreted" },
        semantic_correspondence: { contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT, source_interpretation_handle: "source1", selections: [
          { query: predicate.handle, source: frame.handle, query_excerpt: "completed",
            source_semantic_support: support.kind === "explicit" ? [{ kind: "lexical", mentions: support.mentions }] : [] },
          { query: slot.handle, source: sourceSlot.handle, query_excerpt: "What", source_semantic_support: sourceInterpretation.frames[0]!.slots[0]!.support }
        ] } }), responseMetadata: { finishReason: "STOP" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    }) } });
  expect(aligned.newly_admitted).toBe(1);
  const proofReplay = await replaySemanticChain(root);
  const proofPayload = readChainArtifact(proofReplay.path) as { rows: { response?: unknown }[] };
  const proof = SoulInterpretationResponseSchema.parse(proofPayload.rows[0]!.response);
  expect(proof.operation).toBe("recall");
  if (proof.operation !== "recall") throw new Error("wrong native response");
  expect(proof.proofs?.length).toBeGreaterThan(0);
  expect(proof.discovery?.access?.policy).toBe("canonical-v1");
  expect(proof.index?.as_of).toBe(config.interpretation_clock);
  const selectedSource = ready.descriptors.find((row) => row.interpretation_id === ready.selected_source_interpretation_ids[0])!;
  const measuredRow = measureSemanticChain(root, proofReplay.path, plan.queries.map((row) => ({
    query_key: row.query_key, source_units: row.query_key !== ready.query_key ? [] : [{
      workspace_id: config.workspace_id, root_kind: "source_record", root_id: hashSourceRecordId(selectedSource, fieldContractSha256),
      source_version: selectedSource.source_version, content_digest: selectedSource.content_digest
    }]
  }))).result.rows.find((row) => row.query_key === ready.query_key);
  const proofMeasurement = measuredRow?.measurement;
  expect(proofMeasurement?.status).toBe("validated");
  if (proofMeasurement?.status !== "validated") throw new Error("native proof measurement must be validated");
  expect(proofMeasurement.source_records?.length).toBeGreaterThan(0);
  expect(proofMeasurement.metrics.proof_conditioned_first_exposure.any_at_5.status).toBe("hit");
  expect(measuredRow?.source_bearing_union?.any_at_5.status).toBe("hit");
  expect(measuredRow?.evaluator_usage?.proof_slots_checked).toBeGreaterThan(0);
  expect(measuredRow?.evaluator_usage?.work_units).toBeGreaterThan(0);
  const intervention = interveneSemanticChain(root, proofReplay.path, 32);
  const diagnostic = readChainArtifact(intervention.path) as {
    provider_calls: number; rows: { status: string; effects: { leaf_kind: string; removed_answers: string[] | null }[] }[]
  };
  expect(diagnostic.provider_calls).toBe(0);
  expect(diagnostic.rows[0]!.status).toBe("diagnosed");
  for (const family of ["source_interpretation_", "semantic_correspondence_"]) expect(diagnostic.rows[0]!.effects.some((arm) =>
    arm.leaf_kind.startsWith(family) && (arm.removed_answers?.length ?? 0) > 0)).toBe(true);
  expect(interveneSemanticChain(root, proofReplay.path, 32)).toEqual(intervention);
  for (const [name, rows] of [["missing", []], ["duplicate", [...proofPayload.rows, proofPayload.rows[0]]]] as const) {
    const invalidPath = join(root, `invalid-${name}-replay.json`);
    writeChainArtifact(invalidPath, { ...proofPayload, rows });
    expect(() => interveneSemanticChain(root, invalidPath)).toThrow(/exact query denominator/u);
  }
  const control = await replaySemanticChain(root, "without_semantic_correspondences");
  const controlPayload = readChainArtifact(control.path) as { rows: { response?: unknown }[] };
  const without = SoulInterpretationResponseSchema.parse(controlPayload.rows[0]!.response);
  if (without.operation !== "recall") throw new Error("wrong control response");
  expect(without.proofs ?? []).toHaveLength(0);
  expect(without.index?.as_of).toBe(config.interpretation_clock);
  await assertInterruptedExposure(root, proofReplay.path, ready.query_key);
  await assertPerQueryOpportunity(SemanticChainConfigSchema.parse(config), cacheRoot);
}

async function assertReplayPreparationPool(plan: SemanticChainPlan, root: string): Promise<void> {
  const query = plan.queries[0];
  if (query?.status !== "ready") throw new Error("bounded preparation required");
  await withSemanticChainDaemon(plan.config, root, async (daemon) => {
    const prepared = await discoverSemanticChainQuery(daemon, plan.config, query.original_query, query.query_semantics);
    const request = { operation: "recall", original_query: query.original_query, query_semantics: query.query_semantics,
      semantic_correspondences: [], accepts_unreviewed_conditional_results: true, budget: plan.config.budget,
      output_byte_limit: plan.config.output_byte_limit, authorized_scopes: plan.config.authorized_scopes,
      access_policy: plan.config.access_policy };
    const oneShot = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse(request)));
    const leased = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ ...request, query_handle: prepared.query_handle })));
    if (oneShot.operation !== "recall" || leased.operation !== "recall") throw new Error("native recall required");
    const access = prepared.discovery.discovery_trace.at(-1)!.access;
    expect(oneShot.discovery?.access?.observed_interpretation_count).toBeLessThan(access.observed_interpretation_count);
    expect(leased.discovery?.access).toMatchObject({ pool_id: access.pool_id,
      observed_interpretation_count: access.observed_interpretation_count, unvisited_interpretations: true });
  });
  const replay = await replaySemanticChain(root);
  const payload = readChainArtifact(replay.path) as { rows: { response?: unknown; preparation_trace: {
    access: { pool_id: string }; work: { native_work: number } }[]; preparation_elapsed_ms: number; native_elapsed_ms: number }[] };
  const row = payload.rows[0]!;
  const response = SoulInterpretationResponseSchema.parse(row.response);
  if (response.operation !== "recall") throw new Error("fresh replay recall required");
  expect(response.discovery?.access).toMatchObject({ pool_id: row.preparation_trace.at(-1)!.access.pool_id,
    observed_interpretation_count: query.discovery_trace[0]!.access.observed_interpretation_count,
    unvisited_interpretations: true });
  expect(row.preparation_trace[0]!.work.native_work).toBeGreaterThan(0);
  expect(row.preparation_elapsed_ms).toBeGreaterThan(0);
  expect(row.native_elapsed_ms).toBeGreaterThanOrEqual(row.preparation_elapsed_ms);
  const localIdentityRoot = join(root, "connection-local-pool");
  writeChainArtifact(join(localIdentityRoot, "prepare.json"), { ...plan, queries: plan.queries.map((entry) => entry.status !== "ready" ? entry
    : { ...entry, discovery_trace: entry.discovery_trace.map((page) => ({ ...page,
      access: { ...page.access, pool_id: `sha256:${"0".repeat(64)}` } })) }) });
  expect((await replaySemanticChain(localIdentityRoot)).result).toMatchObject({ rows: [{ status: "replayed" }, { status: "blocked" }] });
  const mismatchRoot = join(root, "changed-observation");
  writeChainArtifact(join(mismatchRoot, "prepare.json"), { ...plan, queries: plan.queries.map((entry) => entry.status !== "ready" ? entry
    : { ...entry, discovery_trace: entry.discovery_trace.map((page) => ({ ...page,
      access: { ...page.access, observed_source_count: page.access.observed_source_count + 1 } })) }) });
  const mismatch = await replaySemanticChain(mismatchRoot);
  expect(mismatch.result).toMatchObject({ rows: [{ status: "native_unavailable", reason: "prepared_access_pool_mismatch", first_exposure: null },
    { status: "blocked" }] });
  const mismatchMeasured = measureSemanticChain(mismatchRoot, mismatch.path,
    plan.queries.map((entry) => ({ query_key: entry.query_key, source_units: [] })));
  expect(mismatchMeasured.result.rows[0]).toMatchObject({ measurement: null,
    preparation_trace: [{ work: { native_work: expect.any(Number) } }], preparation_elapsed_ms: expect.any(Number) });
}

async function assertInterruptedExposure(root: string, output: string, queryKey: string): Promise<void> {
  // Model a crash after exposure reservation but before its result publication.
  // Leave the actual owner's reservation intact, rather than authoring another one.
  const rowPath = join(output.slice(0, -".json".length), `${queryKey}.json`);
  expect(existsSync(`${rowPath}.reserved`)).toBe(true);
  unlinkSync(output); unlinkSync(rowPath);
  await expect(replaySemanticChain(root)).rejects.toThrow(/unresolved after interruption/u);
  expect(existsSync(output)).toBe(false);
  const retained = readdirSync(root).filter((name) => name.startsWith("native-session-"));
  expect(retained).toHaveLength(1);
  expect(existsSync(join(root, retained[0]!, BENCH_DAEMON_DB_FILENAME))).toBe(true);
}
