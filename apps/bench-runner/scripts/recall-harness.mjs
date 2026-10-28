#!/usr/bin/env node
// Lightweight paired recall harness: publish sources, prepare the index once per (question, arm
// preparation), query every arm through the ordinary soul.recall entry, write one JSONL row per
// question x arm. Scoring is separate (recall-harness-score.mjs). Local embedding only.
//
//   node apps/bench-runner/scripts/recall-harness.mjs --out DIR --arms ARMS.json [--limit N] [--ids a,b] [--shard i/n]
//
// ARMS.json: [{ "name": "line", "host": false }, { "name": "message", "host": true,
//              "windowing": "recorded-message-windows.v1", "lexical": "segmented-unicode61.v1",
//              "representation": { "kind": "paired-prefix.v1", "query_prefix": "query: ", "passage_prefix": "passage: " } }, ...]
// Optional "env" on an arm is set for its query only (e.g. a diagnostic recall budget).
// --coordinates FILE loads frozen question-only coordinates; only arms with "question_time": true send time proposals.
// --shard i/n keeps every n-th question; shards may share --out and --cache.
// --capture-pool adds private native observation and separately marked diagnostic rankings to each row.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AlayaError } from "@do-soul/alaya-protocol";
import { installProviderFreeBoundary } from "../src/__tests__/support/provider-free-boundary.ts";
import { loadRecallVectorCache } from "./recall-vector-cache.mjs";

// Install before runtime imports: only local inference and loopback transport are authorized.
const providerFree = installProviderFreeBoundary({
  descendantPreload: new URL("../src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href
});
process.on("exit", () => {
  if (providerFree.violations.length > 0) {
    process.stderr.write(`Provider-free boundary violations: ${providerFree.violations.join(", ")}\n`);
    process.exitCode = 1;
  }
});

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../dist");
const repo = resolve(here, "../../..");
const { publishSourceSemanticSnapshot } = await import(join(dist, "runs/snapshot/source-records/publish.js"));
const { prepareSemanticChainSourceIndex } = await import(join(dist, "runs/recall-measurement/source-index-binding.js"));
const { executeOrdinaryRecallEntry } = await import(join(dist, "runs/recall-measurement/ordinary/ordinary-entry-execution.js"));
const { questionTimeProposalFromCoordinates } = await import(join(dist, "runs/recall-measurement/ordinary/question-time-proposal.js"));
const { chainIdentity } = await import(join(dist, "runs/recall-measurement/contract.js"));
const { readCurrentExtractionAuthorityRevision } = await import(join(dist, "runs/extraction/authority/inspection.js"));

const { values } = parseArgs({ options: {
  out: { type: "string" }, arms: { type: "string" }, limit: { type: "string" }, ids: { type: "string" },
  coordinates: { type: "string" }, cache: { type: "string" }, dataset: { type: "string" }, model: { type: "string" }, shard: { type: "string" },
  "capture-pool": { type: "boolean", default: false }, "diagnostic-vectors": { type: "string" }
} });
if (values["diagnostic-vectors"] && !values["capture-pool"]) throw new AlayaError("VALIDATION", "--diagnostic-vectors requires --capture-pool");
const captureRecallPool = values["capture-pool"] ? (await import("./recall-harness-pool.mjs")).captureRecallPool : undefined;
const diagnosticVectors = await loadRecallVectorCache(values["diagnostic-vectors"]);
if (!values.out || !values.arms) throw new AlayaError("VALIDATION", "--out and --arms are required");
const out = resolve(values.out);
const arms = JSON.parse(readFileSync(values.arms, "utf8"));
if (arms.some(arm => arm.question_time === true) && !values.coordinates) throw new AlayaError("VALIDATION", "question_time requires --coordinates");
const coordinateRows = values.coordinates ? readFileSync(resolve(values.coordinates), "utf8").trim().split("\n").map(JSON.parse) : [];
const coordinates = new Map(coordinateRows.map(row => [row.question_id, row]));
if (coordinates.size !== coordinateRows.length) throw new AlayaError("VALIDATION", "duplicate frozen question coordinates");
const datasetPath = resolve(values.dataset ?? join(repo, "apps/bench-runner/data/longmemeval/longmemeval_s.json"));
const pinnedMeta = join(repo, "docs/bench-history/datasets");
const cohort = JSON.parse(readFileSync(join(pinnedMeta, "longmemeval_s.stratified-100.v1.json"), "utf8"));
const cacheRoot = resolve(values.cache ?? join(repo, "../../.do-it/bench-runs/recall-harness/cache"));
const execution = { cache_root: join(process.env.HOME, ".cache/do-soul-alaya/models"),
  model_id: values.model ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2" };
const revision = readCurrentExtractionAuthorityRevision();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Without the repository pin the loader withholds host capture, so sources fall back to lines.
const unpinnedMeta = join(cacheRoot, "unpinned-meta");
if (!existsSync(join(unpinnedMeta, "longmemeval_s.meta.json"))) {
  mkdirSync(unpinnedMeta, { recursive: true });
  copyFileSync(join(pinnedMeta, "longmemeval_s.meta.json"), join(unpinnedMeta, "longmemeval_s.meta.json"));
}

const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const datasetSha = sha256(readFileSync(datasetPath));
const byId = new Map(dataset.map((question, index) => [question.question_id, { question, index }]));
let ids = values.ids ? values.ids.split(",") : cohort.question_ids;
if (values.limit) ids = ids.slice(0, Number(values.limit));
if (values.shard) {
  const [shard, shards] = values.shard.split("/").map(Number);
  ids = ids.filter((_, offset) => offset % shards === shard);
}

mkdirSync(out, { recursive: true });
const rowsPath = join(out, "rows.jsonl");
const previous = existsSync(rowsPath) ? readFileSync(rowsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
if (previous.some(row => (row.capture_requested === true) !== values["capture-pool"])) {
  throw new AlayaError("CONFLICT", "existing rows use a different pool-capture mode");
}
const done = new Set(previous.map(row => `${row.question_id}:${row.arm}`));

function clockOf(questionDate) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}):(\d{2})$/u.exec(questionDate);
  if (!m) throw new AlayaError("VALIDATION", `unparsed question_date ${questionDate}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
}

function baseConfig({ question, snapshot, snapshotSha, workspace, caches }) {
  const clock = clockOf(question.question_date);
  return {
    snapshot_path: snapshot, snapshot_sha256: snapshotSha, implementation_revision: revision,
    interpretation_clock: clock, workspace_id: workspace, run_id: workspace,
    query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query", model: "gemini-3.1-flash-lite",
      provider_url: "https://generativelanguage.googleapis.com", request_profile: "gemini-3.1-minimal-v1",
      items: [{ original_query: question.question, approved_fixed_context: {
        context_id: `longmemeval_s:${question.question_id}:${datasetSha}`,
        notes: `Question date: ${question.question_date}. Interpretation clock: ${clock}.` } }] },
    query_cache_root: caches.query, correspondence_cache_root: caches.correspondence,
    max_output_tokens: 16384, discovery_page_cap: 4, correspondence_pair_cap: 0,
    access_policy: "query-conditioned-v1",
    budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000, page_budget: 10_000,
      finalization_reserve: 50_000, min_envelope: 10 },
    authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 1_000_000
  };
}

function prepKey(arm) {
  return sha256(JSON.stringify([revision, execution.model_id, arm.host !== false, arm.windowing ?? null, arm.lexical ?? null, ...(arm.representation ? [arm.representation] : [])])).slice(0, 16);
}

/** Returns a prepared chain config, reusing a cached preparation for the same inputs. */
async function prepared(question, index, arm) {
  const dir = join(cacheRoot, question.question_id, prepKey(arm));
  const configPath = join(dir, "prepare", "chain-config.json");
  if (existsSync(configPath)) return JSON.parse(readFileSync(configPath, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const workspace = `harness-${question.question_id}`;
  const snapshot = join(dir, "source.sqlite");
  const publication = await publishSourceSemanticSnapshot({ snapshotPath: snapshot, dataDirRoot: join(dir, "publish"),
    populations: [{ name: "longmemeval_s", dataDir: dirname(datasetPath),
      pinnedMetaRoot: arm.host === false ? unpinnedMeta : pinnedMeta,
      questionWindow: { offset: index, limit: 1 }, model: "gemini-3.1-flash-lite",
      requestProfile: "gemini-3.1-minimal-v1", cacheRoots: [] }],
    recordedAt: "2026-10-26T00:00:00.000Z", producerCommit: revision.split(":")[1], workspaceId: workspace, runId: workspace,
    importEffects: { configDirectoryRoot: dir, sqliteWriteQueue: "disabled", embeddingStartupProbe: "omit", gardenCompute: "disabled" } });
  if (publication.admitted_count !== publication.census_count) throw new AlayaError("CONFLICT", `publication admitted ${publication.admitted_count}/${publication.census_count}`);
  rmSync(join(dir, "publish"), { recursive: true, force: true });
  const caches = { query: join(dir, "empty-query-cache"), correspondence: join(dir, "empty-correspondence-cache") };
  mkdirSync(caches.query); mkdirSync(caches.correspondence);
  const config = baseConfig({ question, snapshot, snapshotSha: publication.db_sha256, workspace, caches });
  const exec = { ...execution, ...(arm.windowing ? { windowing: arm.windowing } : {}),
    ...(arm.lexical ? { lexical: arm.lexical } : {}), ...(arm.representation ? { representation: arm.representation } : {}) };
  const result = await prepareSemanticChainSourceIndex(config, exec, join(dir, "prepare"), undefined, { maxPasses: 10_000 });
  if (result.config === null) throw new AlayaError("UNAVAILABLE", `preparation failed: ${result.report.reason}`);
  return result.config;
}

for (const id of ids) {
  const entry = byId.get(id);
  if (!entry) throw new AlayaError("VALIDATION", `unknown question ${id}`);
  const { question, index } = entry;
  for (const arm of arms) {
    if (done.has(`${id}:${arm.name}`)) continue;
    const started = performance.now();
    const row = { question_id: id, question_type: question.question_type, arm: arm.name,
      arm_identity: chainIdentity(arm),
      ...(values["capture-pool"] ? { capture_requested: true } : {}) };
    try {
      const frozen = coordinates.get(id);
      if (arm.question_time === true && frozen === undefined) throw new AlayaError("VALIDATION", `missing frozen coordinates for ${id}`);
      const proposal = arm.question_time === true
        ? questionTimeProposalFromCoordinates(question.question, clockOf(question.question_date), frozen) : undefined;
      const root = join(out, "runs", id, arm.name);
      if (captureRecallPool !== undefined && existsSync(root)) {
        throw new AlayaError("CONFLICT", "capture root already exists; prior first exposure may be unresolved");
      }
      const config = await prepared(question, index, arm);
      if (captureRecallPool === undefined) rmSync(root, { recursive: true, force: true });
      const saved = Object.fromEntries(Object.keys(arm.env ?? {}).map(key => [key, process.env[key]]));
      Object.assign(process.env, arm.env ?? {});
      let result, observation;
      try {
        result = await executeOrdinaryRecallEntry({ config, root,
          queries: [{ query_key: sha256(question.question), original_query: question.question,
            ...(proposal === undefined ? {} : { interpretation_proposal: proposal }) }] },
          captureRecallPool === undefined ? undefined : (_key, captured) => { observation = captured; });
      } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
      const query = result.rows[0];
      Object.assign(row, { status: query.status, stop_cause: query.stop_cause, snapshot: config.snapshot_path,
        snapshot_sha256: config.snapshot_sha256, workspace: config.workspace_id, implementation_revision: config.implementation_revision,
        input_identity: result.input_identity, snapshot_identity: query.snapshot_identity,
        initial_request: query.pages[0]?.request ?? null,
        intervals: query.source_intervals, pages: query.page_count,
        first_page_slots: query.pages[0]?.occupied_slots ?? null });
      if (captureRecallPool !== undefined) {
        try { row.pool_capture = await captureRecallPool({ row, query, observation, generation: config.source_index?.index,
          coordinates: frozen, vectorCache: diagnosticVectors }); }
        catch (error) { row.pool_capture = { status: "unavailable", issues: [error instanceof Error ? error.message : String(error)] }; }
      }
    } catch (error) {
      Object.assign(row, { status: "error", error: error instanceof Error ? error.message : String(error) });
    }
    row.elapsed_ms = Math.round(performance.now() - started);
    appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
    process.stdout.write(`${id} ${arm.name} ${row.status} ${row.elapsed_ms}ms${row.error ? ` ${row.error}` : ""}\n`);
  }
}
