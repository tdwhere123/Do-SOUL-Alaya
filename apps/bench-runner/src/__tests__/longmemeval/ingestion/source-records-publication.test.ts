import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SoulMemorySearchRequestSchema, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT } from "@do-soul/alaya-soul";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { restoreSnapshotToDataDir } from "../../../runs/snapshot/materialize.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { runSourceSemanticPublicationLauncher } from "../../../runs/snapshot/source-records/launch-publication.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import { measureLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/measure.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { chainIdentity, SemanticChainPlanSchema, readChainArtifact } from "../../../runs/semantic-chain/contract.js";

const roots = new Set<string>();
const CLOCK = "2026-09-13T00:00:00.000Z";
const AS_OF = "2023-09-13T00:00:00.000Z";
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.clear(); });

async function fixture(duplicate = false, abstention = false) {
  const root = await mkdtemp(join(tmpdir(), "source-records-publication-"));
  roots.add(root);
  const dataDir = join(root, "data");
  const pinnedMetaRoot = join(root, "meta");
  const cacheRoot = join(root, "cache");
  await mkdir(dataDir); await mkdir(pinnedMetaRoot); await mkdir(join(cacheRoot, "ab"), { recursive: true });
  const source = JSON.stringify([
    question("mixed-roles", [[{ role: "user", content: "A café source record." },
      { role: "assistant", content: "Noted the café source." }]]),
    question("repeated-text", [[{ role: "user", content: "Please note this. The cat sat. The cat sat. Done." }]]),
    question(abstention ? "absent-interpretation_abs" : "absent-interpretation", [[{ role: "user", content: "Unrelated distractor lives in Suzhou." }]]),
    ...(duplicate ? [question("same-text-other-session", [[{ role: "user", content: "Unrelated distractor lives in Suzhou." }]])] : [])
  ]);
  await writeFile(join(dataDir, "longmemeval_s.json"), source);
  await writeFile(join(pinnedMetaRoot, "longmemeval_s.meta.json"), JSON.stringify({
    sha256: createHash("sha256").update(source).digest("hex"),
    size_bytes: Buffer.byteLength(source), question_count: duplicate ? 4 : 3
  }));
  await writeFile(join(cacheRoot, "ab", `${"ab".repeat(32)}.json`), "{}");
  return { root, dataDir, pinnedMetaRoot, cacheRoot };
}

function question(id: string, sessions: { role: string; content: string }[][]) {
  return {
    question_id: id, question_type: "fixture", question: "What was recorded?", answer: "excluded gold",
    question_date: "2023/09/13 (Wed) 00:00", haystack_session_ids: sessions.map((_, index) => `${id}-session-${index}`),
    haystack_dates: sessions.map(() => "2023/09/12 (Tue) 00:00"), answer_session_ids: [`${id}-session-0`],
    haystack_sessions: sessions
  };
}

describe("complete-source census and publication", () => {
  it("keeps original question haystacks isolated through source-only development and evaluator-only scoring", async () => {
    const f = await fixture(false, true);
    const census = await censusCompleteSourceRecords({ population: "longmemeval_s", dataDir: f.dataDir, pinnedMetaRoot: f.pinnedMetaRoot });
    const root = join(f.root, "development"), queryCache = join(f.root, "query-cache");
    const frozen = await freezeLongMemEvalSemanticRun({ data_dir: f.dataDir, pinned_meta_root: f.pinnedMetaRoot,
      dataset_sha256: census.dataset_sha256, dataset_question_count: 3, question_ids: ["mixed-roles", "absent-interpretation_abs"],
      model: "gemini-2.5-flash-lite", provider_url: "http://127.0.0.1:9", request_profile: "gemini-2.5-nonthinking-v1", query_cache_root: queryCache,
      recorded_at: CLOCK, producer_commit: "a".repeat(40), max_output_tokens: 4096, output_byte_limit: 1000000,
      budget: { schema_version: 1, work_units: 1000000, memory_bytes: 60000000, page_budget: 100000,
        finalization_reserve: 10000, min_envelope: 10 } }, root);
    expect(frozen).toMatchObject({ contract: "longmemeval-semantic-development-v3", order_policy: "native_canonical_source_root_order" });
    expect(frozen.selected.map((row) => row.source_manifest.length)).toEqual([1, 1]);
    expect(frozen.selected.every((row) => row.interpretation_clock === AS_OF)).toBe(true);
    expect(JSON.stringify(frozen)).not.toContain("excluded gold");
    const blocked = await prepareLongMemEvalSemanticRun(root);
    const blockedReplay = await replayLongMemEvalSemanticRun(root, blocked.path);
    const blockedMeasurement = await measureLongMemEvalSemanticRun(root, blockedReplay.path);
    expect(blockedMeasurement.result.primary).toMatchObject({ eligible: 1, unknown: 1, lower_bound: 0, upper_bound: 1 });
    const published = blocked.result.rows[0]!;
    if (published.status !== "prepared") throw new Error("question publication required");
    unlinkSync(published.publication_path);
    expect((await prepareLongMemEvalSemanticRun(root)).result).toEqual(blocked.result);
    const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(frozen.query_workset, queryCache, 4096),
      inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
    const filled = await executeSemanticProposalFill({ workset: frozen.query_workset, cacheRoot: queryCache, authority,
      config: { providerUrl: "http://127.0.0.1:9", model: frozen.config.model, requestProfile: "gemini-2.5-nonthinking-v1", apiKey: "fixture" },
      extractor: { extract: async () => ({ rawJson: JSON.stringify({ contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, query: { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, alternatives: [{ conditions: [{
          kind: "statement", key: "record", predicate: "record", arguments: [{ role: "theme", target: { kind: "free", key: "theme" }, excerpt: "What" }]
        }] }], return: ["theme"], gaps: [] } }), responseMetadata: { finishReason: "STOP" },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) } });
    expect(filled.newly_admitted).toBe(2);
    const prepared = await prepareLongMemEvalSemanticRun(root);
    expect(prepared.result.rows).toEqual(frozen.selected.map(({ question_id }) => ({ question_id, status: "prepared",
      chain_root: expect.any(String), publication_path: expect.any(String), publication_identity: expect.any(String) })));
    for (const row of prepared.result.rows) {
      if (row.status !== "prepared") throw new Error(row.reason);
      const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(row.chain_root, "prepare.json")));
      expect(plan.config.access_policy).toBe("canonical-v1");
      expect(plan.queries.every((query) => query.status === "ready"
        && query.discovery_trace.every((page) => page.access.policy === "canonical-v1"))).toBe(true);
    }
    const replayed = await replayLongMemEvalSemanticRun(root, prepared.path);
    expect(await replayLongMemEvalSemanticRun(root, prepared.path)).toEqual(replayed);
    const measured = await measureLongMemEvalSemanticRun(root, replayed.path);
    expect(measured.result).toMatchObject({ contract: "longmemeval-semantic-measurement-v2", order_policy: "native_canonical_source_root_order" });
    expect(measured.result.inventory).toEqual({ questions: 3, answerable: 2, abstention: 1 });
    expect(measured.result.rows.find((row) => row.selected && row.cohort === "answerable")?.reason).toBeNull();
    expect(measured.result.primary).toMatchObject({ eligible: 1, hits: 1, misses: 0, unknown: 0, target_decision: "development_only" });
    expect(measured.result.rows).toHaveLength(3);
    expect(measured.result.rows.find((row) => row.question_id === "absent-interpretation_abs")?.outcome).toBe("uncalibrated");
    expect(measured.result.rows.find((row) => row.question_id === "repeated-text")?.outcome).toBe("not_selected_development");
    const receipt = readFileSync(published.publication_path, "utf8");
    const changed = JSON.parse(receipt).payload;
    changed.sources[0].record_id = "foreign-root";
    writeFileSync(published.publication_path, JSON.stringify({ identity: chainIdentity(changed), payload: changed }));
    const unavailable = await measureLongMemEvalSemanticRun(root, replayed.path);
    expect(unavailable.result.primary).toMatchObject({ eligible: 1, hits: 0, unknown: 1 });
    expect(unavailable.result.rows.find((row) => row.question_id === "mixed-roles")?.reason).toMatch(/publication changed/u);
    writeFileSync(published.publication_path, receipt);
    const formalRoot = join(f.root, "formal");
    await expect(freezeLongMemEvalSemanticRun({ ...frozen.config, stage: "formal",
      previously_exposed_question_ids: [] }, formalRoot)).rejects.toThrow(/entire original dataset/u);
    const formal = await freezeLongMemEvalSemanticRun({ ...frozen.config, stage: "formal",
      previously_exposed_question_ids: ["mixed-roles"],
      question_ids: frozen.inventory.map(row => row.question_id), query_cache_root: join(f.root, "formal-empty-cache") }, formalRoot);
    expect(formal.exposure).toBe("formal_with_recorded_development_exposure");
    const formalPrepared = await prepareLongMemEvalSemanticRun(formalRoot);
    const formalReplay = await replayLongMemEvalSemanticRun(formalRoot, formalPrepared.path);
    const formalMeasurement = await measureLongMemEvalSemanticRun(formalRoot, formalReplay.path);
    expect(formalMeasurement.result.primary).toMatchObject({ eligible: 2, hits: 0, unknown: 2, target_decision: "unresolved" });
    expect(formalMeasurement.result.formal_target).toMatchObject({ eligible: 2, strict_over_90_required_hits: 2,
      status: "unresolved", additional_confirmed_hits_needed: 2 });
    expect(formalMeasurement.result.rows.filter(row => row.prior_development_exposure).map(row => row.question_id)).toEqual(["mixed-roles"]);
    expect(formalMeasurement.result.rows.filter(row => row.cohort === "answerable")
      .every(row => row.attribution.layer === "query_unavailable")).toBe(true);
  }, 60000);

  it("rejects invalid or repeated publication associations before creating the snapshot", async () => {
    const f = await fixture();
    const census = await censusCompleteSourceRecords({ population: "fixture", dataDir: f.dataDir, pinnedMetaRoot: f.pinnedMetaRoot });
    const source = census.records[0]!;
    const binding = { source_id: source.source_id, source_version: source.source_version,
      generation_key: "ab".repeat(32), request_digest: "c".repeat(64) };
    const base = { snapshotPath: join(f.root, "invalid.sqlite"), dataDirRoot: join(f.root, "invalid-seed"),
      recordedAt: CLOCK, producerCommit: "a".repeat(40) };
    for (const [cacheRoot, bindings] of [[undefined, [binding]], [f.cacheRoot, [binding, binding]]] as const) {
      await expect(publishSourceSemanticSnapshot({ ...base, populations: [{
        name: "fixture", dataDir: f.dataDir, pinnedMetaRoot: f.pinnedMetaRoot, cacheRoots: cacheRoot === undefined ? [] : [cacheRoot],
        model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1", publicationAssociations: bindings
      }] })).rejects.toThrow(/association requires a cache root|association repeats a source/u);
      expect(existsSync(base.snapshotPath)).toBe(false);
      expect(existsSync(base.dataDirRoot)).toBe(false);
    }
  });
  it("preserves identical text belonging to distinct source sessions", async () => {
    const f = await fixture(true);
    const census = await censusCompleteSourceRecords({ population: "fixture", dataDir: f.dataDir, pinnedMetaRoot: f.pinnedMetaRoot });
    expect(census.records).toHaveLength(4);
    const duplicate = census.records.filter((row) => row.content_bytes.includes("Suzhou"));
    expect(duplicate).toHaveLength(2);
    expect(new Set(duplicate.map((row) => row.source_id)).size).toBe(2);
    expect(new Set(duplicate.map((row) => row.session_id)).size).toBe(2);
  });
  it("rejects repeated cache roots and ambiguous generation keys before creating any snapshot", async () => {
    const f = await fixture();
    const second = join(f.root, "second-cache");
    await mkdir(join(second, "ab"), { recursive: true });
    await writeFile(join(second, "ab", `${"ab".repeat(32)}.json`), "{}");
    for (const cacheRoots of [[f.cacheRoot, f.cacheRoot], [f.cacheRoot, second]]) {
      const snapshotPath = join(f.root, "ambiguous.sqlite"), dataDirRoot = join(f.root, "ambiguous-runtime");
      await expect(publishSourceSemanticSnapshot({ snapshotPath, dataDirRoot, recordedAt: CLOCK,
        producerCommit: "a".repeat(40), populations: [{ name: "fixture", dataDir: f.dataDir,
          pinnedMetaRoot: f.pinnedMetaRoot, cacheRoots, model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" }]
      })).rejects.toThrow(/repeat a generation directory|occurs in multiple cache roots/u);
      expect(existsSync(snapshotPath)).toBe(false);
      expect(existsSync(dataDirRoot)).toBe(false);
    }
  });
  it("keeps census and publication ownership out of the launcher", async () => {
    expect(await runSourceSemanticPublicationLauncher([])).toBe(2);
  });

  it("derives identity from the frozen dataset and keeps mixed roles", async () => {
    const f = await fixture();
    const census = await censusCompleteSourceRecords({
      population: "fixture", dataDir: f.dataDir, pinnedMetaRoot: f.pinnedMetaRoot
    });
    expect(census.records).toHaveLength(3);
    expect(census.records.map((row) => row.source_id).every((id) => !/^[a-f0-9]{64}$/u.test(id))).toBe(true);
    expect(census.records.map((row) => row.source_id).sort()).toEqual([
      "fixture:absent-interpretation-s0-r0", "fixture:mixed-roles-s0-r0", "fixture:repeated-text-s0-r0"
    ].sort());
    expect(new Set(census.records.map((row) => row.source_version))).toEqual(new Set([census.dataset_sha256]));
    const mixed = census.records.find((row) => row.question_id === "mixed-roles")!;
    expect(mixed.speaker).toBeUndefined();
    expect(mixed.roles).toEqual(["user", "assistant"]);
    expect(new Set(mixed.units.map((unit) => unit.source_role))).toEqual(new Set(["user", "assistant"]));
    const repeated = census.records.find((row) => row.question_id === "repeated-text")!;
    expect(repeated.repeated_assertion_text).toBe(true);
    expect(repeated.speaker).toBe("user");
  });

  it("admits every census source when source interpretation is absent and keeps failed source interpretation source retrieval", async () => {
    const f = await fixture();
    const report = await publishSourceSemanticSnapshot({
      snapshotPath: join(f.root, "library.sqlite"), dataDirRoot: join(f.root, "seed"),
      recordedAt: CLOCK, producerCommit: "a".repeat(40),
      populations: [{
        name: "fixture", dataDir: f.dataDir, pinnedMetaRoot: f.pinnedMetaRoot,
        cacheRoots: [f.cacheRoot], model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1"
      }]
    });
    expect(report.census_count).toBe(3);
    expect(report.admitted_count).toBe(3);
    expect(report.rejected_count).toBe(0);
    expect(report.published_count).toBe(0);
    expect(report.source_interpretation_counts.absent).toBe(3);
    expect(report.unbound_source_interpretation_artifacts).toEqual([{ population: "fixture", generation_key: "ab".repeat(32), status: "invalid" }]);
    expect(report.source_interpretation_binding_complete).toBe(false);
    expect(report.sources.every((row) => row.admission === "admitted")).toBe(true);
    expect(report.sources.every((row) => row.source_interpretation === "absent" && row.publication === "not_attempted")).toBe(true);
    const db = new Database(report.snapshot_path, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM source_records").get()).toMatchObject({ n: 3 });
      expect(db.prepare("SELECT count(*) AS n FROM memory_entries").get()).toMatchObject({ n: 0 });
    } finally { db.close(); }
    const restoreRoot = join(f.root, "restore");
    restoreSnapshotToDataDir({ snapshotDbPath: report.snapshot_path, dataDirRoot: restoreRoot, expectedSha256: report.db_sha256 });
    const daemon = await startBenchDaemon({
      dataDirRoot: restoreRoot, workspaceId: report.workspace_id, runId: report.run_id, embeddingMode: "disabled"
    });
    try {
      const response = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", SoulMemorySearchRequestSchema.parse({
        query: "Unrelated distractor lives in Suzhou.", max_results: 20, result_kind_view: "source_only",
        scope_class: null, dimension: null, domain_tags: null, source_observed_at: AS_OF,
        protocol_version: 1, supports_source_evidence: true,
        supported_result_kinds: ["source_evidence"], supports_product_updates: true
      }));
      const roots = new Set(response.results.flatMap((result) =>
        result.target.kind === "source_evidence" ? [result.target.root_id] : []));
      expect(roots.size).toBe(3);
      expect(roots).toEqual(new Set(report.sources.map((row) => row.record_id)));
    } finally {
      await daemon.shutdown();
    }
  }, 120000);
});
