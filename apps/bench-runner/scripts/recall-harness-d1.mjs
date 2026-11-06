#!/usr/bin/env node
// Lightweight paired recall harness: publish sources, prepare the index once per (question, arm
// preparation), query every arm through the ordinary soul.recall entry, write one JSONL row per
// question x arm. Scoring is separate (recall-harness-score.mjs). Local embedding only.
//
//   node apps/bench-runner/scripts/recall-harness.mjs --out DIR --arms ARMS.json [--limit N] [--ids a,b] [--shard i/n]
//
// ARMS.json: [{ "name": "message", "host": true,
//              "windowing": "recorded-message-windows.v1", "lexical": "segmented-unicode61.v1",
//              "representation": { "kind": "paired-prefix.v1", "query_prefix": "query: ", "passage_prefix": "passage: " } }, ...]
// Optional "env" on an arm is set for its query only (e.g. a diagnostic recall budget).
// --coordinates FILE loads frozen question-only coordinates; only arms with "question_time": true send time proposals.
// --shard i/n keeps every n-th question; shards may share --out and --cache.
// --capture-pool adds private native observation and separately marked diagnostic rankings to each row.
// --source-model, --source-cache and --source-artifact-digest select a separately bound Source model;
// --model and --model-cache select Memory; --model-artifact-digest binds its sealed tree.
// --warm-memory probes the Memory provider independently.
// --source-lexical-work explicitly allocates model-free lexical preparation work per pass.
// --source-pass-limits JSON raises the preparation producer's per-pass caps (fewer, larger passes).
// --prepared-cache DIR --prepared-revision REV only read preparations another checkout sealed; valid only
// when that checkout's preparation path is unchanged here. Rows keep both revisions; nothing is prepared.
// --historical-preparation pre-statement-map.v1 explicitly admits the named archived producers by
// their config, original snapshot hash and preparation receipt, not current preparation source equality.
// --reader end_continuation also reads each cut slot on after the membership window (scored separately).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { installProviderFreeBoundary } from "../src/__tests__/support/provider-free-boundary.ts";
import { writeFileSync } from "node:fs";

// Install before runtime imports: only local inference and loopback transport are authorized.
const providerFree = installProviderFreeBoundary({
  descendantPreload: new URL("../src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href
});
process.on("exit", () => {
  try { providerFree.assertSafe(true); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (process.exitCode !== providerFree.signalFailureExitCode) process.exitCode = 1;
  }
});

const { AlayaError, captureSourceIndexLexicalPreparationAllocation } = await import("@do-soul/alaya-protocol");
const { loadRecallVectorCache } = await import("./recall-vector-cache.mjs");
const { recallExecutionIdentity, recallPreparationKey, assertRecallCachedPreparation } = await import("./recall-harness-selection.mjs");

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../dist");
const repo = resolve(here, "../../..");
const { values } = parseArgs({ options: {
  out: { type: "string" }, arms: { type: "string" }, limit: { type: "string" }, ids: { type: "string" },
  coordinates: { type: "string" }, cache: { type: "string" }, dataset: { type: "string" }, model: { type: "string" }, shard: { type: "string" },
  "model-cache": { type: "string" }, "model-artifact-digest": { type: "string" },
  "source-model": { type: "string" }, "source-cache": { type: "string" },
  "source-artifact-digest": { type: "string" }, "source-lexical-work": { type: "string" }, "source-pass-limits": { type: "string" },
  "prepared-cache": { type: "string" }, "prepared-revision": { type: "string" }, "historical-preparation": { type: "string" },
  "warm-memory": { type: "boolean", default: false },
  "capture-pool": { type: "boolean", default: false }, "diagnostic-vectors": { type: "string" },
  reader: { type: "string", default: "current" }
} });
if (!values.out || !values.arms) throw new AlayaError("VALIDATION", "--out and --arms are required");
const producerPassLimits = values["source-pass-limits"] === undefined ? undefined : JSON.parse(values["source-pass-limits"]);
if (!["current", "end_continuation"].includes(values.reader)) throw new AlayaError("VALIDATION", "--reader must be current or end_continuation");
if (values["diagnostic-vectors"] && !values["capture-pool"]) throw new AlayaError("VALIDATION", "--diagnostic-vectors requires --capture-pool");
const lexicalPreparation = values["source-lexical-work"] === undefined ? undefined
  : captureSourceIndexLexicalPreparationAllocation({ work: Number(values["source-lexical-work"]) });
for (const name of ["model", "model-cache", "model-artifact-digest", "source-model", "source-cache", "source-artifact-digest"]) {
  if (values[name] === "") throw new AlayaError("VALIDATION", `--${name} must not be empty`);
}
const sourceOptions = [values["source-model"], values["source-cache"], values["source-artifact-digest"]];
if (sourceOptions.some(Boolean) && !sourceOptions.every(Boolean)) {
  throw new AlayaError("VALIDATION", "separate Source execution requires model, cache and artifact digest");
}
if (values["source-artifact-digest"] && !/^sha256:[a-f0-9]{64}$/u.test(values["source-artifact-digest"])) {
  throw new AlayaError("VALIDATION", "Source artifact digest must be sha256 plus 64 lowercase hex digits");
}
if (values["model-artifact-digest"] && !/^sha256:[a-f0-9]{64}$/u.test(values["model-artifact-digest"])) {
  throw new AlayaError("VALIDATION", "Memory artifact digest must be sha256 plus 64 lowercase hex digits");
}
if (sourceOptions.every(Boolean) && !values["model-artifact-digest"]) {
  throw new AlayaError("VALIDATION", "separate Source execution requires the Memory artifact digest");
}
if ((values["prepared-cache"] === undefined) !== (values["prepared-revision"] === undefined)) {
  throw new AlayaError("VALIDATION", "--prepared-cache and --prepared-revision are required together");
}
if (values["prepared-cache"] !== undefined && (values["source-pass-limits"] !== undefined || values.cache !== undefined)) {
  throw new AlayaError("VALIDATION", "a recall-only consumer neither prepares nor owns a cache");
}

if (values["historical-preparation"] !== undefined && (values["historical-preparation"] !== "pre-statement-map.v1"
  || values["prepared-cache"] === undefined)) throw new AlayaError("VALIDATION", "historical preparation requires its supported version and explicit consumer mode");

// Reject invalid invocations before loading the daemon and native runtime graph.
const { publishSourceSemanticSnapshot } = await import(pathToFileURL(join(dist, "runs/snapshot/source-records/publish.js")).href);
const { prepareSemanticChainSourceIndex } = await import(pathToFileURL(join(dist, "runs/recall-measurement/source-index-binding.js")).href);
const { executeOrdinaryRecallEntry } = await import(pathToFileURL(join(dist, "runs/recall-measurement/ordinary/ordinary-entry-execution.js")).href);
const { queryProposalFromCoordinates } = await import(pathToFileURL(join(dist, "runs/recall-measurement/ordinary/query-coordinate-proposal.js")).href);
const { chainIdentity, writeChainArtifact } = await import(pathToFileURL(join(dist, "runs/recall-measurement/contract.js")).href);
const { admitHistoricalRecallPreparation, assertHistoricalRecallProducer } = await import(pathToFileURL(join(dist, "runs/recall-measurement/historical-preparation.js")).href);
const { captureRecallRuntimeBuild } = await import("./recall-runtime-binding.mjs");
const { readCurrentExtractionAuthorityRevision } = await import(pathToFileURL(join(dist, "runs/extraction/authority/inspection.js")).href);
const { loadSelectedQuestionMetadata, longMemEvalDatasetInputPaths } = await import(pathToFileURL(join(dist, "datasets/longmemeval/ingestion/fetch.js")).href);

const captureRecallPool = values["capture-pool"] ? (await import("./recall-harness-pool.mjs")).captureRecallPool : undefined;
const diagnosticVectors = await loadRecallVectorCache(values["diagnostic-vectors"]);
const out = resolve(values.out);
const arms = JSON.parse(readFileSync(values.arms, "utf8"));
if (lexicalPreparation !== undefined && arms.some(arm => arm.lexical === undefined)) {
  throw new AlayaError("VALIDATION", "--source-lexical-work requires an explicit lexical representation on every arm");
}
// Round roots are host-session captures; line-only sources without host structure are retired.
if (arms.some(arm => arm.host === false)) throw new AlayaError("VALIDATION", "arms without host capture are retired");
if (arms.some(arm => arm.question_time === true) && !values.coordinates) throw new AlayaError("VALIDATION", "question_time requires --coordinates");
const coordinateRows = values.coordinates ? readFileSync(resolve(values.coordinates), "utf8").trim().split("\n").map(JSON.parse) : [];
const coordinates = new Map(coordinateRows.map(row => [row.question_id, row]));
if (coordinates.size !== coordinateRows.length) throw new AlayaError("VALIDATION", "duplicate frozen question coordinates");
const datasetPath = resolve(values.dataset ?? join(repo, "apps/bench-runner/data/longmemeval/longmemeval_s.json"));
const pinnedMeta = join(repo, "docs/bench-history/datasets");
const cohort = JSON.parse(readFileSync(join(pinnedMeta, "longmemeval_s.stratified-100.v1.json"), "utf8"));
const cacheRoot = resolve(values.cache ?? join(repo, "../../.do-it/bench-runs/recall-harness/cache"));
const memory = { cache_root: resolve(values["model-cache"] ?? join(process.env.HOME, ".cache/do-soul-alaya/models")),
  model_id: values.model ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2" };
const execution = sourceOptions.every(Boolean) ? { cache_root: resolve(values["source-cache"]),
  model_id: values["source-model"], source_scope: "separate", artifact_digest: values["source-artifact-digest"],
  memory: { ...memory, artifact_digest: values["model-artifact-digest"] },
  ...(values["warm-memory"] ? { memory_warmup: "eager" } : {}) } :
  { ...memory, ...(values["model-artifact-digest"] ? { artifact_digest: values["model-artifact-digest"] } : {}),
    ...(values["warm-memory"] ? { memory_warmup: "eager" } : {}) };
const revision = readCurrentExtractionAuthorityRevision();
const preparationRevision = values["prepared-revision"] ?? revision;
// Ownership is selected by the explicit mode, not by whether the revisions differ.
const consumer = values["prepared-cache"] !== undefined;
const historical = values["historical-preparation"];
if (historical !== undefined) assertHistoricalRecallProducer(historical, preparationRevision);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

let ids = values.ids ? values.ids.split(",") : cohort.question_ids;
if (values.limit) ids = ids.slice(0, Number(values.limit));
if (values.shard) {
  const [shard, shards] = values.shard.split("/").map(Number);
  ids = ids.filter((_, offset) => offset % shards === shard);
}
const datasetOptions = { dataDir: dirname(datasetPath), pinnedMetaRoot: pinnedMeta };
const canonicalDataset = longMemEvalDatasetInputPaths("longmemeval_s", datasetOptions).sourcePath;
if (resolve(canonicalDataset) !== datasetPath) throw new AlayaError("VALIDATION", "--dataset must name the canonical longmemeval_s.json file");
const metadata = await loadSelectedQuestionMetadata("longmemeval_s", { ...datasetOptions, questionIds: ids });
const datasetSha = metadata.sha256;
const byId = new Map(metadata.entries.map(entry => [entry.question.question_id, entry]));

if (historical !== undefined && existsSync(out)) throw new AlayaError("CONFLICT", "historical recall requires a fresh output root");
mkdirSync(out, { recursive: true });
const runtime = captureRecallRuntimeBuild(repo, revision);
const runtimeIdentity = chainIdentity(runtime);
writeChainArtifact(join(out, "runtime.json"), runtime);
writeChainArtifact(join(out, `isolation-${providerFree.evidence.member}.json`), providerFree.evidence);
writeChainArtifact(join(out, "invocation.json"), { runtime_identity: runtimeIdentity, question_ids: ids, arms,
  dataset_sha256: datasetSha, reader: values.reader, capture_pool: values["capture-pool"],
  coordinates_sha256: values.coordinates === undefined ? null : sha256(readFileSync(values.coordinates)),
  producer_revision: preparationRevision, historical_preparation: historical ?? null });
const rowsPath = join(out, "rows.jsonl");
const previous = existsSync(rowsPath) ? readFileSync(rowsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const executionIdentity = recallExecutionIdentity(values, execution, revision, chainIdentity);
const preparationIdentity = recallExecutionIdentity(values, execution, preparationRevision, chainIdentity);
if (previous.some(row => (row.consumer_revision !== undefined) !== consumer)) {
  throw new AlayaError("CONFLICT", "existing rows use a different preparation ownership");
}
if (previous.some(row => row.source_execution_identity !== executionIdentity)) {
  throw new AlayaError("CONFLICT", "existing rows use a different Source or Memory execution");
}
if (previous.some(row => (row.capture_requested === true) !== values["capture-pool"])) {
  throw new AlayaError("CONFLICT", "existing rows use a different pool-capture mode");
}
if (previous.some(row => (row.reader ?? "current") !== values.reader)) {
  throw new AlayaError("CONFLICT", "existing rows use a different reader");
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

// Statements are published into the sealed snapshot, so the map and its caches are preparation input.
let statementMap;
try {
  // These immutable producer versions predate statementMapDigest. Their original keys never read it.
  statementMap = historical !== undefined || process.env.STATEMENT_MAP === undefined ? undefined
    : (await import("./recall-statement-keys.mjs")).statementMapDigest();
} catch (error) {
  if (consumer && error?.code === "ENOENT") throw new AlayaError("UNAVAILABLE",
    "original statement map or referenced cache is missing; sealed preparation identity cannot be verified", { cause: error });
  throw error;
}

function prepKey(arm) {
  return recallPreparationKey(preparationRevision, preparationIdentity, execution, arm, lexicalPreparation, statementMap);
}

function statementFormation(dir) {
  const path = join(dir, "d1-statements.json");
  if (!existsSync(path)) return { status: "unavailable", reason: "report_missing" };
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (report.status !== "published" || ["sessions", "unmapped_sessions", "messages", "matched_messages", "keyed_messages", "statements"]
      .some(key => !Number.isInteger(report[key]) || report[key] < 0) || !Array.isArray(report.raw_gaps) || !Array.isArray(report.rejections)) {
      return { status: "unavailable", reason: "report_invalid" };
    }
    return { status: report.unmapped_sessions || report.raw_gaps.length || report.rejections.length
      || report.matched_messages < report.messages ? "partial"
      : report.statements === 0 ? "empty" : "available",
      sessions: report.sessions, unmapped_sessions: report.unmapped_sessions, raw_gaps: report.raw_gaps.length,
      rejections: report.rejections.length, messages: report.messages, matched_messages: report.matched_messages,
      keyed_messages: report.keyed_messages, statements: report.statements };
  } catch {
    return { status: "unavailable", reason: "report_invalid" };
  }
}

/** Returns a prepared chain config and formation observation without altering the seal. */
async function prepared(question, index, arm) {
  const dir = join(consumer ? resolve(values["prepared-cache"]) : cacheRoot, question.question_id, prepKey(arm));
  const configPath = join(dir, "prepare", "chain-config.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assertRecallCachedPreparation(config, preparationRevision, execution, arm);
    if (historical !== undefined) {
      const admitted = admitHistoricalRecallPreparation({ version: historical, producerRevision: preparationRevision,
        configPath, root: join(out, "historical-inputs", question.question_id, arm.name) });
      return { ...admitted, formation: statementFormation(dir) };
    }
    return { config: consumer ? { ...config, consumer_revision: revision } : config, formation: statementFormation(dir) };
  }
  if (consumer) throw new AlayaError("UNAVAILABLE", `no sealed preparation for ${question.question_id} in --prepared-cache`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const workspace = `harness-${question.question_id}`;
  const snapshot = join(dir, "source.sqlite");
  const publication = await publishSourceSemanticSnapshot({ snapshotPath: snapshot, dataDirRoot: join(dir, "publish"),
    populations: [{ name: "longmemeval_s", dataDir: dirname(datasetPath),
      pinnedMetaRoot: pinnedMeta,
      questionWindow: { offset: index, limit: 1 }, model: "gemini-3.1-flash-lite",
      requestProfile: "gemini-3.1-minimal-v1", cacheRoots: [] }],
    recordedAt: "2026-10-26T00:00:00.000Z", producerCommit: revision.split(":")[1], workspaceId: workspace, runId: workspace,
    importEffects: { configDirectoryRoot: dir, sqliteWriteQueue: "disabled", embeddingStartupProbe: "omit", gardenCompute: "disabled" } });
  if (publication.admitted_count !== publication.census_count) throw new AlayaError("CONFLICT", `publication admitted ${publication.admitted_count}/${publication.census_count}`);
  rmSync(join(dir, "publish"), { recursive: true, force: true });
  // Statements enter the sealed snapshot before preparation, so SourceIndex captures them.
  const { publishStatementKeys } = await import("./recall-statement-keys.mjs");
  const statements = await publishStatementKeys({ snapshot, workspace, question, publication });
  writeFileSync(join(dir, "d1-statements.json"), JSON.stringify(statements, null, 2));
  const snapshotSha = statements.db_sha256 ?? publication.db_sha256;
  const caches = { query: join(dir, "empty-query-cache"), correspondence: join(dir, "empty-correspondence-cache") };
  mkdirSync(caches.query); mkdirSync(caches.correspondence);
  const config = baseConfig({ question, snapshot, snapshotSha, workspace, caches });
  const exec = { ...execution, ...(arm.windowing ? { windowing: arm.windowing } : {}),
    ...(arm.lexical ? { lexical: arm.lexical } : {}), ...(arm.representation ? { representation: arm.representation } : {}) };
  const result = await prepareSemanticChainSourceIndex(config, exec, join(dir, "prepare"), undefined,
    { maxPasses: 10_000, ...(lexicalPreparation === undefined ? {} : { lexicalPreparation }),
      ...(producerPassLimits === undefined ? {} : { producerPassLimits }) });
  if (result.config === null) throw new AlayaError("UNAVAILABLE", `preparation failed: ${result.report.reason}`);
  return { config: result.config, formation: statementFormation(dir) };
}

function assertDispatchSafe() {
  try { providerFree.assertSafe(true); }
  catch (error) {
    writeChainArtifact(join(out, `isolation-failure-${randomUUID()}.json`), {
      ...providerFree.evidence, status: "failed", reasons: error.reasons ?? ["isolation_signal_unknown"] });
    throw error;
  }
}

for (const id of ids) {
  const entry = byId.get(id);
  if (!entry) throw new AlayaError("VALIDATION", `unknown question ${id}`);
  const { question, index } = entry;
  for (const arm of arms) {
    assertDispatchSafe();
    if (done.has(`${id}:${arm.name}`)) continue;
    const started = performance.now();
    let preparation;
    const row = { question_id: id, question_type: question.question_type, arm: arm.name, runtime_identity: runtimeIdentity,
      arm_identity: chainIdentity(arm),
      ...(executionIdentity === undefined ? {} : { source_execution_identity: executionIdentity }),
      ...(consumer ? { consumer_revision: revision } : {}),
      ...(values["capture-pool"] ? { capture_requested: true } : {}),
      ...(values.reader === "current" ? {} : { reader: values.reader }),
      formation: { question_time: { status: arm.question_time === true ? "unavailable" : "not_requested" },
        statements: { status: "unavailable", reason: "preparation_not_read" } } };
    try {
      const frozen = coordinates.get(id);
      if (arm.question_time === true && frozen === undefined) throw new AlayaError("VALIDATION", `missing frozen coordinates for ${id}`);
      const proposal = arm.question_time === true
        ? queryProposalFromCoordinates(question.question, clockOf(question.question_date), frozen) : undefined;
      if (arm.question_time === true) row.formation.question_time = { status: frozen.status,
        proposal: proposal === undefined ? "not_issued" : "issued" };
      const root = join(out, "runs", id, arm.name);
      if (captureRecallPool !== undefined && existsSync(root)) {
        throw new AlayaError("CONFLICT", "capture root already exists; prior first exposure may be unresolved");
      }
      preparation = await prepared(question, index, arm);
      const config = preparation.config;
      if (historical !== undefined) row.historical_preparation = { contract: historical, config_sha256: preparation.identity,
        original_snapshot: config.snapshot_path, original_snapshot_sha256: config.snapshot_sha256,
        receipt_identity: config.source_index.preparation_identity, producer_revision: config.implementation_revision };
      row.formation.statements = preparation.formation;
      if (captureRecallPool === undefined) rmSync(root, { recursive: true, force: true });
      const saved = Object.fromEntries(Object.keys(arm.env ?? {}).map(key => [key, process.env[key]]));
      Object.assign(process.env, arm.env ?? {});
      let result, observation;
      try {
        result = await executeOrdinaryRecallEntry({ config, root,
          queries: [{ query_key: sha256(question.question), original_query: question.question,
            ...(proposal === undefined ? {} : { interpretation_proposal: proposal }) }],
          ...(values.reader === "current" ? {} : { reader: values.reader }) },
          captureRecallPool === undefined ? undefined : (_key, captured) => { observation = captured; });
      } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
      const query = result.rows[0];
      Object.assign(row, { status: query.status, stop_cause: query.stop_cause, snapshot: config.consumer_snapshot_path ?? config.snapshot_path,
        snapshot_sha256: config.snapshot_sha256, workspace: config.workspace_id, implementation_revision: config.implementation_revision,
        ...(config.consumer_revision === undefined ? {} : { consumer_revision: config.consumer_revision }),
        input_identity: result.input_identity, snapshot_identity: query.snapshot_identity,
        initial_request: query.pages[0]?.request ?? null,
        intervals: query.source_intervals, pages: query.page_count,
        first_page_slots: query.pages[0]?.occupied_slots ?? null,
        ...(query.end_continuation === undefined ? {} : { end_continuation: query.end_continuation }) });
      if (captureRecallPool !== undefined) {
        try { row.pool_capture = await captureRecallPool({ row, query, observation, generation: config.source_index?.index,
          coordinates: frozen, vectorCache: diagnosticVectors }); }
        catch (error) { row.pool_capture = { status: "unavailable", issues: [error instanceof Error ? error.message : String(error)] }; }
      }
    } catch (error) {
      Object.assign(row, { status: error instanceof AlayaError && error.code === "UNAVAILABLE" ? "unavailable" : "error",
        error: error instanceof Error ? error.message : String(error) });
    } finally { preparation?.finish?.(); }
    row.elapsed_ms = Math.round(performance.now() - started);
    appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
    process.stdout.write(`${id} ${arm.name} ${row.status} ${row.elapsed_ms}ms${row.error ? ` ${row.error}` : ""}\n`);
    // Preserve the raw per-item result and completed cleanup before a cohort stop.
    // A caught guard refusal is independent of the row's ordinary status.
    assertDispatchSafe();
  }
}
assertDispatchSafe();
const finalRuntime = captureRecallRuntimeBuild(repo, readCurrentExtractionAuthorityRevision());
if (chainIdentity(finalRuntime) !== runtimeIdentity) throw new AlayaError("CONFLICT", "recall runtime source or build changed during execution");
writeChainArtifact(join(out, "runtime-final.json"), { runtime_identity: runtimeIdentity, unchanged: true });
