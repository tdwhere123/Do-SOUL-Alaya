import { sourceSemanticRequestCatalog } from "@do-soul/alaya-soul";
import { join } from "node:path";
import { FirstExposurePageSchema } from "../../../runs/measurement/first-exposure-session.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect } from "vitest";
import { SoulInterpretationResponseSchema, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT,
  type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { listRetainedSourceSemanticKeys } from "../../../runs/snapshot/source-records/publish.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { LongMemEvalExperimentFreezeSchema } from "../../../runs/longmemeval-semantic/contract.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun, LongMemEvalPublicationSchema } from "../../../runs/longmemeval-semantic/execute.js";
import { measureLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/measure.js";
import { SemanticChainPlanSchema, readChainArtifact, type SemanticChainConfig } from "../../../runs/semantic-chain/contract.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { materializeSemanticProposalLines, type SemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";

/** Authored engineering outputs enter the existing raw/authority/receive owners; no model fidelity claim. */
export async function assertNativeLongMemEvalArm(dataDir: string, pinnedMetaRoot: string, cacheRoots: string[]) {
  const root = join(cacheRoots[0]!, "native-experiment"), queryCache = join(root, "query-cache"), correspondenceCache = join(root, "correspondence-cache");
  const model = "gemini-2.5-flash-lite", profile = "gemini-2.5-nonthinking-v1";
  const census = await censusCompleteSourceRecords({ population: "longmemeval_s", dataDir, pinnedMetaRoot });
  const unsupportedGold = census.records.find(source => source.question_id === "q3" && source.session_id === "s-q3")!;
  expect(unsupportedGold).toBeDefined();
  expect(unsupportedGold.content_bytes).not.toMatch(/repair/u);
  expect(unsupportedGold.units.every(unit => !unit.text.includes("repair"))).toBe(true);
  const retained = cacheRoots.flatMap((cache) => listRetainedSourceSemanticKeys(cache).map((key) => ({ key,
    result: inspectCachedSourceSemantic(cache, key, model, profile) })));
  const associations = census.records.filter((source) => ["q0", "q1"].includes(source.question_id)).map((source) => {
    const cached = retained.find(({ result }) => result.status === "hit" && sourceSemanticRequestCatalog(result.admitted.request).source_digest === source.corpus_digest)!;
    if (cached.result.status !== "hit") throw new Error("authored source interpretation required");
    return { source_id: source.source_id, source_version: source.source_version, generation_key: cached.key, request_digest: cached.result.requestDigest };
  });
  // One absent interpretation remains a native source in its complete original haystack.
  const frozen = await freezeLongMemEvalSemanticRun({ arm: "native_semantic", workspace_prefix: "authored-native-arm",
    source_cache_roots: cacheRoots, source_publication_associations: associations.slice(0, -1), correspondence_cache_root: correspondenceCache,
    discovery_page_cap: 4, correspondence_pair_cap: 2, authorized_scopes: { mode: "named", scopes: ["project"] },
    data_dir: dataDir, pinned_meta_root: pinnedMetaRoot, dataset_sha256: census.dataset_sha256,
    dataset_question_count: 9, question_ids: ["q0", "q1", "q2", "q3"], previously_exposed_question_ids: ["q0", "q1", "q2", "q3"],
    model, provider_url: "http://127.0.0.1:9", request_profile: profile, query_cache_root: queryCache,
    recorded_at: "2026-09-21T00:00:00.000Z", producer_commit: "a".repeat(40), max_output_tokens: 4096, output_byte_limit: 100000,
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 60000000, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 }
  }, root);
  if (frozen.contract !== "longmemeval-native-semantic-v3") throw new Error("native freeze required");
  expect(frozen).toMatchObject({ order_policy: "evidence_support",
    native_route: { access_policy: "query-conditioned-v1", order: { enumeration_policy: "evidence_support" } } });
  expect(LongMemEvalExperimentFreezeSchema.safeParse({ ...frozen, order_policy: "native_canonical_source_root_order" }).success).toBe(false);
  expect(LongMemEvalExperimentFreezeSchema.safeParse({ ...frozen, contract: "longmemeval-native-semantic-v2" }).success).toBe(false);
  expect(frozen.metric).toBe("source-bearing-union-first-exposure-any-at-k-v1");
  expect(frozen.selected.map((row) => row.source_manifest.length)).toEqual([2, 2, 2, 2]);
  expect(JSON.stringify(frozen)).not.toContain("answer q0");
  await fillAuthored({ ...frozen.query_workset, items: frozen.query_workset.items.filter((_item, index) => index !== 2) }, queryCache, authoredQuery);
  const invalidQuery = materializeSemanticProposalLines(frozen.query_workset, 4096)[2]!;
  const invalidPath = semanticProposalShardPath(queryCache, invalidQuery.key);
  mkdirSync(dirname(invalidPath), { recursive: true }); writeFileSync(invalidPath, "{}");
  const prepared = await prepareLongMemEvalSemanticRun(root);
  expect(prepared.result.rows).toEqual(frozen.selected.map(({ question_id }) => ({ question_id, status: "prepared",
    chain_root: expect.any(String), publication_path: expect.any(String), publication_identity: expect.any(String) })));
  for (const row of prepared.result.rows) {
    if (row.status !== "prepared") throw new Error(row.reason);
    const publication = readChainArtifact(row.publication_path) as { census_count: number; admitted_count: number; published_count: number };
    expect(publication).toMatchObject({ census_count: 2, admitted_count: 2 });
    const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(row.chain_root, "prepare.json")));
    expect(plan.config.access_policy).toBe("query-conditioned-v1");
    if (row.question_id === "q2") {
      expect(publication.published_count).toBe(0);
      expect(plan.queries[0]).toMatchObject({ status: "blocked", reason: "cache_invalid" });
      continue;
    }
    if (row.question_id === "q3") {
      expect(publication.published_count).toBe(0);
      expect(plan.queries[0]).toMatchObject({ status: "ready", descriptors: [], correspondence_opportunities: [] });
    }
    else expect(publication.published_count).toBeGreaterThan(0);
    expect(LongMemEvalPublicationSchema.safeParse(publication).success).toBe(row.question_id === "q3");
    expect(plan.queries[0]).toMatchObject({ status: "ready", discovery_open: false });
    if (plan.queries[0]?.status === "ready") expect(plan.queries[0].discovery_trace.every((page) =>
      page.access.policy === "query-conditioned-v1")).toBe(true);
  }
  if (prepared.result.contract !== "longmemeval-native-semantic-prepared-v1") throw new Error("native preparation required");
  // One combined workset feeds one existing durable authority across all query opportunities.
  await fillAuthored(prepared.result.correspondence_workset!, correspondenceCache, authoredCorrespondence);
  const replay = await replayLongMemEvalSemanticRun(root, prepared.path);
  expect(await replayLongMemEvalSemanticRun(root, prepared.path)).toEqual(replay);
  for (const row of replay.result.rows) {
    if (row.status !== "replayed") throw new Error(row.reason);
    const native = readChainArtifact(row.replay_path) as { rows: { status: string; response?: unknown; first_exposure?: unknown }[] };
    if (row.question_id === "q2") { expect(native.rows[0]!.status).toBe("blocked"); continue; }
    const response = SoulInterpretationResponseSchema.parse(native.rows[0]!.response);
    if (response.operation !== "recall") throw new Error("native recall required");
    expect(response.order).toEqual(frozen.native_route.order);
    expect(response.order?.enumeration_policy).toBe(frozen.order_policy);
    if (row.question_id === "q3") {
      expect(response.proofs ?? []).toEqual([]);
      expect(JSON.stringify(response.results)).not.toMatch(/repair/u);
      const publication = LongMemEvalPublicationSchema.parse(readChainArtifact(row.publication_path));
      const gold = publication.sources.find(source => source.session_id === "s-q3")!;
      expect(gold).toMatchObject({ admission: "admitted", record_id: expect.any(String) });
      const page = FirstExposurePageSchema.parse(native.rows[0]!.first_exposure);
      expect(page.initial?.slots.some(slot => slot.target.kind === "source_evidence" && slot.target.root_id === gold.record_id)).toBe(true);
    } else expect(response.proofs?.length).toBeGreaterThan(0);
    expect(native.rows[0]!.first_exposure).not.toBeNull();
    expect(response.provider_attempts).toBe(0);
    expect(response.discovery?.access?.policy).toBe("query-conditioned-v1");
  }
  const measured = await measureLongMemEvalSemanticRun(root, replay.path);
  expect(measured.result).toMatchObject({ contract: "longmemeval-native-semantic-measurement-v3", provider_calls: 0,
    order_policy: "evidence_support",
    primary: { eligible: 4, hits: 3, misses: 0, unknown: 1 } });
  expect(measured.result.rows.filter((row) => row.outcome === "hit" && row.question_id !== "q3").every((row) => row.mechanism === "proof_exercised")).toBe(true);
  expect(measured.result.rows.filter((row) => row.selected).every((row) => row.prior_development_exposure)).toBe(true);
  const unsupportedRow = measured.result.rows.find(row => row.question_id === "q3")!;
  expect(unsupportedRow).toMatchObject({ outcome: "hit", mechanism: "not_exercised" });
  expect(readChainArtifact(unsupportedRow.measurement_path!)).toMatchObject({ rows: [{
    diagnostics: { order: frozen.native_route.order },
    measurement: { status: "validated", metrics: {
      mixed_kind_first_exposure: { any_at_5: { status: "hit" } },
      proof_conditioned_first_exposure: { any_at_5: { status: "miss" } }
    } },
    source_bearing_union: { any_at_5: { status: "hit" } },
    mechanism: { status: "unexercised", validated_proof_ranks: [] },
    evaluator_usage: { proof_slots_checked: 0 }
  }] });
  const manifest = join(cacheRoots[0]!, "manifest.json"), bytes = readFileSync(manifest);
  writeFileSync(manifest, "{}");
  try { await expect(prepareLongMemEvalSemanticRun(root)).rejects.toThrow(/source interpretation cache changed/u); }
  finally { writeFileSync(manifest, bytes); }
}

export async function assertPerQueryOpportunity(config: SemanticChainConfig, root: string) {
  // This separate control owns a new full workset, not renewed capacity in the earlier control's grant.
  config = { ...config, query_cache_root: join(root, "query-cache") };
  await fillAuthored(config.query_workset, config.query_cache_root, authoredQuery);
  const forward = await prepareSemanticChain(config, join(root, "forward-opportunities"));
  const reverse = await prepareSemanticChain({ ...config,
    query_workset: { ...config.query_workset, items: [...config.query_workset.items].reverse() }
  }, join(root, "reverse-opportunities"));
  for (const query of forward.queries) {
    if (query.status !== "ready") throw new Error(query.reason);
    expect(query.selected_source_interpretation_ids).toHaveLength(config.correspondence_pair_cap);
    const reversed = reverse.queries.find((row) => row.query_key === query.query_key)!;
    if (reversed.status !== "ready") throw new Error(reversed.reason);
    expect(reversed.selected_source_interpretation_ids).toEqual(query.selected_source_interpretation_ids);
    expect(reversed.correspondence_opportunities).toEqual(query.correspondence_opportunities);
  }
  expect(forward.correspondence_workset?.items).toHaveLength(2 * config.correspondence_pair_cap);
  const zero = await prepareSemanticChain({ ...config, correspondence_pair_cap: 0 }, join(root, "zero-opportunities"));
  expect(zero.correspondence_workset).toBeNull();
  expect(zero.queries.every((query) => query.status === "ready" && query.correspondence_opportunities.every((row) => row.decision === "zero_budget"))).toBe(true);
}

function authoredQuery(userPrompt: string) {
  const original = (JSON.parse(userPrompt) as { original_query: string }).original_query;
  const predicate = original === "What was repaired?" ? "repair" : "complete";
  return JSON.stringify({ contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
    outcome: { status: "interpreted" }, query: { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, alternatives: [{ conditions: [{
      kind: "statement", key: "condition", predicate, arguments: [{ role: "theme", target: { kind: "free", key: "theme", return: true }, excerpt: "What" }]
    }] }], gaps: [] } });
}

function authoredCorrespondence(userPrompt: string) {
  const request = JSON.parse(userPrompt) as SourceSemanticCorrespondenceRequest;
  const interpretation = request.source_interpretation_descriptors[0]!.interpretation;
  const support = interpretation.frames[0]!.predicate_support;
  return JSON.stringify({ contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT, outcome: { status: "interpreted" },
    semantic_correspondence: { contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT, source_interpretation_handle: "source1", selections: [
      { query: request.catalog!.query_endpoints.find((entry) => entry.kind === "predicate")!.handle,
        source: request.catalog!.source_endpoints.find((entry) => entry.kind === "frame")!.handle, query_excerpt: "completed",
        source_semantic_support: support.kind === "explicit" ? [{ kind: "lexical", mentions: support.mentions }] : [] },
      { query: request.catalog!.query_endpoints.find((entry) => entry.kind === "slot")!.handle,
        source: request.catalog!.source_endpoints.find((entry) => entry.kind === "slot")!.handle, query_excerpt: "What",
        source_semantic_support: interpretation.frames[0]!.slots[0]!.support }
    ] } });
}

async function fillAuthored(workset: SemanticProposalWorkset, cacheRoot: string, raw: (userPrompt: string) => string) {
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, 4096),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  const result = await executeSemanticProposalFill({ workset, cacheRoot, authority,
    config: { providerUrl: "http://127.0.0.1:9", model: workset.model, requestProfile: "gemini-2.5-nonthinking-v1", apiKey: "fixture" },
    extractor: { extract: async ({ userPrompt }) => ({ rawJson: raw(userPrompt), responseMetadata: { finishReason: "STOP" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) } });
  expect(result.terminal_failures).toBe(0);
}
