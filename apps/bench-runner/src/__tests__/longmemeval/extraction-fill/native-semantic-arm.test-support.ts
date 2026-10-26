import { sourceSemanticRequestCatalog } from "@do-soul/alaya-soul";
import { assessmentForTestPairs } from "../../support/semantic-correspondence-assessment.js";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect } from "vitest";
import { SoulInterpretationResponseSchema, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, sourceSemanticExecutionPhases } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
  type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { listRetainedSourceSemanticKeys } from "../../../runs/snapshot/source-records/publish.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { LongMemEvalExperimentFreezeSchema, LongMemEvalNativeSemanticConfigSchema } from "../../../runs/longmemeval-semantic/contract.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun, LongMemEvalPublicationSchema } from "../../../runs/longmemeval-semantic/execute.js";
import { measureLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/measure.js";
import { SemanticChainPlanSchema, readChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { semanticProposalShardPath } from "../../../runs/semantic-cache/artifact.js";
import { seedRetainedSemanticCache } from "../../runs/semantic-cache/retained-cache.test-support.js";
import { materializeSemanticProposalLines, type SemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { interpretedQueryRaw } from "../query-producer-fixture.js";

/** Authored Q/C evidence exercises native delivery and archived measurement refusal, not model fidelity. */
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
  expect(LongMemEvalNativeSemanticConfigSchema.safeParse({ ...frozen.config,
    correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 } }).success).toBe(false);
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
      expect(plan.queries[0]).toMatchObject({ status: "raw_ready", reason: "cache_invalid",
        query_semantics_unavailable: "invalid" });
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
  assertNativeReplays(replay.result.rows, census, frozen.config.budget.page_budget);
  const measured = await measureLongMemEvalSemanticRun(root, replay.path, join(cacheRoots[0]!, "..", "native-evaluator"));
  expect(measured.result).toMatchObject({ contract: "longmemeval-native-semantic-measurement-v3", provider_calls: 0,
    order_policy: "evidence_support",
    primary: { eligible: 4, hits: 0, misses: 0, unknown: 4 } });
  const selectedRows = measured.result.rows.filter(row => row.selected);
  expect(selectedRows).toHaveLength(4);
  for (const row of selectedRows) {
    expect(row).toMatchObject({ outcome: "unknown", reason: "invalid_response", mechanism: "not_exercised",
      prior_development_exposure: true, attribution: { layer: "invalid_measurement" } });
    expect(readChainArtifact(row.measurement_path!)).toMatchObject({
      gold: [{ query_key: frozen.selected.find(selected => selected.question_id === row.question_id)!.query_key,
        source_units: null }],
      rows: [{ measurement: { status: "invalid", reason: "invalid_response" },
        mechanism: { status: "unexercised", reason: "invalid_response", validated_proof_ranks: [] },
        evaluator_usage: { proof_slots_checked: 0 } }]
    });
  }
  const unavailableRow = selectedRows.find(row => row.question_id === "q2")!;
  expect(readChainArtifact(unavailableRow.measurement_path!)).toMatchObject({ rows: [{
    query_failure_reason: "cache_invalid", diagnostics: { query_semantics_status: { status: "unavailable", reason: "invalid" } }
  }] });
  const scopedRoot = join(root, "scoped-zero-cap");
  await freezeLongMemEvalSemanticRun({ ...frozen.config, question_ids: ["q0"],
    workspace_prefix: "authored-scoped-arm",
    correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 },
    correspondence_cap: 0 }, scopedRoot);
  const scopedPrepared = await prepareLongMemEvalSemanticRun(scopedRoot);
  const scopedRow = scopedPrepared.result.rows[0]!;
  if (scopedRow.status !== "prepared") throw new Error(scopedRow.reason);
  const scopedPlan = SemanticChainPlanSchema.parse(readChainArtifact(join(scopedRow.chain_root, "prepare.json")));
  expect(scopedPlan.config).toMatchObject({ correspondence_cap: 0,
    correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 } });
  expect(scopedPlan.correspondence_workset).toBeNull();
  expect(scopedPlan.queries[0]?.status).toBe("ready");
  if (scopedPlan.queries[0]?.status === "ready") {
    const opportunities = scopedPlan.queries[0].correspondence_demand_opportunities;
    expect(opportunities?.length).toBeGreaterThan(0);
    expect(opportunities?.every(row => row.decision === "zero_budget")).toBe(true);
  }
  const manifest = join(cacheRoots[0]!, "manifest.json"), bytes = readFileSync(manifest);
  writeFileSync(manifest, "{}");
  try { await expect(prepareLongMemEvalSemanticRun(root)).rejects.toThrow(/source interpretation cache changed/u); }
  finally { writeFileSync(manifest, bytes); }
}

function assertNativeReplays(
  rows: Awaited<ReturnType<typeof replayLongMemEvalSemanticRun>>["result"]["rows"],
  census: Awaited<ReturnType<typeof censusCompleteSourceRecords>>, pageBudget: number
) {
  for (const row of rows) {
    if (row.status !== "replayed") throw new Error(row.reason);
    const native = readChainArtifact(row.replay_path) as { rows: { status: string; response?: unknown; first_exposure?: unknown }[] };
    expect(native.rows[0]!.status).toBe("replayed");
    const response = SoulInterpretationResponseSchema.parse(native.rows[0]!.response);
    if (response.operation !== "recall" || response.protocol_version !== 12) throw new Error("native field recall required");
    // The prepared library pool includes both original haystack sources, independently of proof availability.
    expect(response.order).toEqual({ enumeration_policy: "native_query", tie_policy: "canonical_identity",
      occupancy: "tagged_target_identity", occupancy_prefix: 2, page_budget: pageBudget });
    expect(response.index.result_version).toBe("ordinary-native-field.v4");
    const publication = readChainArtifact(row.publication_path) as { sources: {
      source_id: string; record_id: string; source_version: string; content_digest: string
    }[] };
    expect(response.results).toHaveLength(2);
    expect(response.results.map(({ target }) => target.kind === "source_evidence" ? target.root_id : null).sort())
      .toEqual(publication.sources.map(source => source.record_id).sort());
    for (const result of response.results) {
      if (result.target.kind !== "source_evidence") throw new Error("authored haystack must deliver source evidence");
      const target = result.target;
      const published = publication.sources.find(source => source.record_id === target.root_id)!;
      expect(published).toBeDefined();
      const original = census.records.find(source => source.source_id === published.source_id)!;
      expect(target).toMatchObject({ root_kind: "source_record", source_version: published.source_version,
        content_digest: published.content_digest });
      const span = target.span!;
      expect(span).toBeDefined();
      expect(span.content_end).toBeGreaterThan(span.content_start);
      expect(result.content_preview).toBe(Buffer.from(original.content_bytes)
        .subarray(span.content_start, span.content_end).toString("utf8"));
    }
    if (row.question_id === "q3") {
      expect(response.proofs ?? []).toEqual([]);
      expect(JSON.stringify(response.results)).not.toMatch(/repair/u);
      const publication = LongMemEvalPublicationSchema.parse(readChainArtifact(row.publication_path));
      const gold = publication.sources.find(source => source.session_id === "s-q3")!;
      expect(gold).toMatchObject({ admission: "admitted", record_id: expect.any(String) });
      expect(response.results.some(result => result.target.kind === "source_evidence" && result.target.root_id === gold.record_id)).toBe(true);
    } else if (row.question_id === "q2") {
      expect(response.query_semantics_status).toEqual({ status: "unavailable", reason: "invalid" });
      expect(response.proofs ?? []).toEqual([]);
    } else expect(response.proofs?.length).toBeGreaterThan(0);
    // The archived source-gold capture does not relabel a tagged field page as its own exposure.
    expect(native.rows[0]!.first_exposure).toBeNull();
    expect(sourceSemanticExecutionPhases(response.execution).query_preparation.external_api_attempts).toBe(0);
    expect(response.discovery.access).toBeUndefined();
  }
}

function authoredQuery(userPrompt: string) {
  const original = (JSON.parse(userPrompt) as { original_query: string }).original_query;
  const predicate = original === "What was repaired?" ? "repair" : "complete";
  return interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, alternatives: [{ conditions: [{
      kind: "statement", key: "condition", predicate, arguments: [{ role: "theme", target: { kind: "free", key: "theme", return: true }, excerpt: "What" }]
    }] }], gaps: [] });
}

function authoredCorrespondence(userPrompt: string) {
  const request = JSON.parse(userPrompt) as SourceSemanticCorrespondenceRequest;
  const interpretation = request.source_interpretation_descriptors[0]!.interpretation;
  const support = interpretation.frames[0]!.predicate_support;
  return JSON.stringify({ contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT, outcome: { status: "interpreted" },
    semantic_correspondence: { contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, source_interpretation_handle: "source1", assessments: assessmentForTestPairs(request.catalog, request.original_query, [
      { query: request.catalog!.query_endpoints.find((entry) => entry.kind === "predicate")!.handle,
        source: request.catalog!.source_endpoints.find((entry) => entry.kind === "frame")!.handle, query_excerpt: "completed",
        source_semantic_support: support.kind === "explicit" ? [{ kind: "lexical", mentions: support.mentions }] : [] },
      { query: request.catalog!.query_endpoints.find((entry) => entry.kind === "slot")!.handle,
        source: request.catalog!.source_endpoints.find((entry) => entry.kind === "slot")!.handle, query_excerpt: "What",
        source_semantic_support: interpretation.frames[0]!.slots[0]!.support }
    ]) } });
}

async function fillAuthored(workset: SemanticProposalWorkset, cacheRoot: string, raw: (userPrompt: string) => string) {
  const retained = seedRetainedSemanticCache(workset, cacheRoot, 4096, raw);
  expect(retained.admittedCount).toBe(retained.lines.length);
}
