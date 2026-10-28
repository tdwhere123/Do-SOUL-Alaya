#!/usr/bin/env node
// Native source acquisition fingerprint over prepared harness snapshots, for old-vs-new equivalence.
//
//   node apps/bench-runner/scripts/acquisition-equivalence.mjs --dist ROOT --out DUMP.json --vectors VECTORS.json
//        [--cache DIR] [--ids a,b] [--limit N] [--reps 3] [--ordinary]
//   node apps/bench-runner/scripts/acquisition-equivalence.mjs --diff OLD.json NEW.json
//
// ROOT is a built worktree root. Query vectors are embedded once (production prepareQuery path, local model)
// and cached in VECTORS.json so every dist consumes identical vectors. Snapshots are copied to scratch first.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AlayaError } from "@do-soul/alaya-protocol";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  dist: { type: "string" }, out: { type: "string" }, vectors: { type: "string" }, cache: { type: "string" },
  ids: { type: "string" }, limit: { type: "string" }, reps: { type: "string" }, diff: { type: "boolean" },
  ordinary: { type: "boolean" }
} });

const BUDGETS = { large: { work_units: 4_000_000, memory_bytes: 40_000_000 }, small: { work_units: 9884, memory_bytes: 933818 },
  ...(values.ordinary ? { ordinary: { work_units: 10_000, memory_bytes: 1_000_000 } } : {}) };

if (values.diff) process.exit(diff(positionals[0], positionals[1]));

const root = resolve(values.dist ?? ""), load = (path) => import(pathToFileURL(join(root, path)).href);
const core = await load("packages/core/dist/index.js"), storage = await load("packages/storage/dist/index.js");
const { NATIVE_SOURCE_NOMINATION_ALLOWANCE: allowance, nominateNativeSources } = await load("apps/core-daemon/dist/runtime/recall-read-worker/observer-operations.js");
const Database = createRequire(join(root, "packages/storage/package.json"))("better-sqlite3");
const cacheRoot = resolve(values.cache ?? join(repo, "../../.do-it/bench-runs/recall-harness/cache"));
const cohort = JSON.parse(readFileSync(join(repo, "docs/bench-history/datasets/longmemeval_s.stratified-100.v1.json"), "utf8")).question_ids;
const questions = new Map(JSON.parse(readFileSync(join(repo, "apps/bench-runner/data/longmemeval/longmemeval_s.json"), "utf8"))
  .map(q => [q.question_id, q.question]));
let ids = values.ids ? values.ids.split(",") : cohort;
if (values.limit) ids = ids.slice(0, Number(values.limit));
const snapshots = ids.flatMap(id => existsSync(join(cacheRoot, id)) ? readdirSync(join(cacheRoot, id)).sort()
  .map(key => ({ id, key, file: join(cacheRoot, id, key, "prepare/source-index.sqlite") })).filter(s => existsSync(s.file)) : []);

const vectorsPath = resolve(values.vectors);
const vectors = existsSync(vectorsPath) ? JSON.parse(readFileSync(vectorsPath, "utf8")) : {};
const scratch = mkdtempSync(join(tmpdir(), "acquisition-equivalence-"));
const sha = (text) => createHash("sha256").update(text).digest("hex");
const fieldSha = core.fieldContractSha256;
let client;

function open(snapshot) {
  const file = join(scratch, "snapshot.sqlite");
  copyFileSync(snapshot.file, file);
  const connection = new Database(file, { readonly: true, fileMustExist: true });
  const database = new storage.StorageDatabase(file, connection);
  const workspace = connection.prepare("SELECT workspace_id FROM source_index_selections").pluck().get();
  return { connection, database, workspace, close: () => { connection.close(); rmSync(file, { force: true }); } };
}

async function queryVector(snapshot, db) {
  const name = `${snapshot.id}/${snapshot.key}`;
  if (vectors[name]) return { ...vectors[name], embedding: Float32Array.from(vectors[name].embedding) };
  client ??= new core.LocalOnnxEmbeddingClient({ modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    cacheDir: join(process.env.HOME, ".cache/do-soul-alaya/models") });
  const repository = new storage.SqliteSourceIndexRepository(db.database, fieldSha);
  const state = repository.state(db.workspace);
  if (!("selection" in state)) throw new AlayaError("UNAVAILABLE", `${name}: no selection`);
  const prepared = await core.SourceIndexAcquisition.prepareQuery({ navigation: questions.get(snapshot.id),
    selection: state.selection, bind: options => client.bindSourceEmbedding(options),
    signal: new AbortController().signal, remainingMs: () => 120_000 });
  if (prepared.vector.status !== "available") throw new AlayaError("UNAVAILABLE", `${name}: ${prepared.receipt.reason}`);
  const { status, profile, profile_id, input_digest, embedding } = prepared.vector;
  vectors[name] = { status, profile, profile_id, input_digest, embedding: [...embedding] };
  return { ...vectors[name], embedding };
}

function acquire(db, vector, navigation, budget, observed, ordinary = false) {
  const repository = new storage.SqliteSourceIndexRepository(db.database, fieldSha, { captureReadTargets: true });
  const acquisition = new core.SourceIndexAcquisition(repository, fieldSha);
  const facts = {};
  const observer = observed ? (capture, kind) => { (facts[kind] ??= []).push(capture()); } : undefined;
  return db.connection.transaction(() => {
    const started = performance.now();
    if (ordinary) {
      const { result, witness, retained_bytes } = nominateNativeSources(db.database, { workspaceId: db.workspace,
        query: navigation, authorizedScopes: ["project"], budget }, vector);
      return { ms: performance.now() - started, result, witness, retained_bytes, facts };
    }
    const { result, witness } = acquisition.nominateWithWitness({ workspace_id: db.workspace, navigation_text: navigation,
      vector, allowance, budget }, () => "admitted", "original", observer);
    return { ms: performance.now() - started, result, witness, facts };
  })();
}

const plain = (value) => JSON.parse(JSON.stringify(value));
function fingerprint({ result, witness, facts }) {
  const { resources, nominations, lexical, vector, ...rest } = result;
  return { identity: plain({ ...rest,
    nominations: nominations.map(n => ({ root_key: n.source.root_key, lexical: n.lexical, vector: n.vector })),
    lexical: { ...lexical, tokenization: lexical.tokenization && sha(JSON.stringify(lexical.tokenization)) },
    vector: { completion: vector.completion, reason: vector.reason, inspected_windows: vector.inspected_windows,
      invalid_windows: vector.invalid_windows, state: vector.state, validation: vector.validation },
    witness: witness.map(w => ({ reference: w.reference, attempt: w.attempt, view: w.view, route: w.route, root_key: w.source.root_key })),
    facts: Object.fromEntries(Object.entries(facts).map(([kind, rows]) => [kind, { count: rows.length, sha256: sha(JSON.stringify(rows)) }])) }),
  resources };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const reps = Number(values.reps ?? 3), dump = {};
try {
  for (const snapshot of snapshots) {
    const db = open(snapshot);
    try {
      const vector = await queryVector(snapshot, db), navigation = questions.get(snapshot.id), entry = {};
      if (Object.keys(dump).length === 0) for (let i = 0; i < 5; i++) acquire(db, vector, navigation, BUDGETS.large, false);
      for (const [label, budget] of Object.entries(BUDGETS)) {
        // Observed run fingerprints every fact; timing runs have no observer so cloning does not dominate.
        const timed = Array.from({ length: reps }, () => acquire(db, vector, navigation, budget, false, label === "ordinary"));
        entry[label] = { ...fingerprint(acquire(db, vector, navigation, budget, true, label === "ordinary")),
          ms: median(timed.map(run => run.ms)), ...(label === "ordinary" ? { retained_bytes: timed[0].retained_bytes } : {}) };
      }
      dump[`${snapshot.id}/${snapshot.key}`] = entry;
    } finally { db.close(); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); await client?.close(); }
mkdirSync(dirname(vectorsPath), { recursive: true });
writeFileSync(vectorsPath, JSON.stringify(vectors));
writeFileSync(resolve(values.out), JSON.stringify(dump));
console.log(`${Object.keys(dump).length} snapshots -> ${values.out}`);
if (values.ordinary) {
  const entries = Object.values(dump);
  console.log(JSON.stringify({ ordinary_vector_complete: entries.filter(row => row.ordinary.identity.vector.completion === "complete").length,
    nominations_equal_large: entries.filter(row => JSON.stringify(row.ordinary.identity.nominations) === JSON.stringify(row.large.identity.nominations)).length,
    snapshots: entries.length }));
}
process.exit(0);

function diff(oldPath, newPath) {
  const [a, b] = [oldPath, newPath].map(path => JSON.parse(readFileSync(path, "utf8")));
  const pct = (xs, p) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)];
  let mismatches = 0;
  for (const label of Object.keys(BUDGETS)) {
    const identity = { same: 0, differ: [] }, resources = { same: 0, differ: 0 }, ms = { old: [], new: [] };
    const names = Object.keys(a).filter(name => name in b);
    for (const name of names) {
      const [x, y] = [a[name][label], b[name][label]];
      if (JSON.stringify(x.identity) === JSON.stringify(y.identity)) identity.same++;
      else identity.differ.push(name);
      if (JSON.stringify(x.resources) === JSON.stringify(y.resources)) resources.same++; else resources.differ++;
      ms.old.push(x.ms); ms.new.push(y.ms);
    }
    console.log(`\n[${label}] identity same ${identity.same}/${names.length} (old-only ${Object.keys(a).length - names.length}); resources same ${resources.same}, differ ${resources.differ}`);
    for (const [kind, xs] of Object.entries(ms)) {
      console.log(`  ${kind} ms  p50 ${pct(xs, 0.5).toFixed(1)}  p95 ${pct(xs, 0.95).toFixed(1)}  max ${Math.max(...xs).toFixed(1)}`);
    }
    for (const name of identity.differ) {
      const [x, y] = [a[name][label].identity, b[name][label].identity];
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
      console.log(`  DIFF ${name}: ${keys.join(",")}`);
      if (label === "large") mismatches++;
    }
  }
  return mismatches === 0 ? 0 : 1;
}
