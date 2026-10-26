#!/usr/bin/env node
// Evaluation-only: gold-root membership of native nominations as max_roots grows. Candidates come from
// captureNative (lexical lanes, per-root vector order); nominations replay the interleaved prefix with every
// admission ready, checked against the run's own 16-root nominations. Gold roots hold a has_answer occurrence.
//
//   node apps/bench-runner/scripts/acquisition-roots-sweep.mjs --run DIR [--arm NAME] [--dist ROOT]
// DIR holds rows.jsonl, query-vectors.json and native-acquisition.json from a recall-harness run.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { run: { type: "string" }, arm: { type: "string" }, dist: { type: "string" } } });
const run = resolve(values.run), dist = resolve(values.dist ?? join(here, "../../.."));
const load = path => import(pathToFileURL(join(dist, path)).href);
const core = await load("packages/core/dist/index.js"), storage = await load("packages/storage/dist/index.js");
const Database = createRequire(join(dist, "packages/storage/package.json"))("better-sqlite3");
const dataset = new Map(JSON.parse(readFileSync(join(here, "../data/longmemeval/longmemeval_s.json"), "utf8")).map(q => [q.question_id, q]));
const vectors = JSON.parse(readFileSync(join(run, "query-vectors.json"), "utf8"));
const native = JSON.parse(readFileSync(join(run, "native-acquisition.json"), "utf8"));
const rows = readFileSync(join(run, "rows.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  .filter(row => row.arm === (values.arm ?? "message-allowance") && !["error", "failed", "unavailable"].includes(row.status));
const ROOTS = [16, 32, 64, 128];
const unlimited = { work_units: 40_000_000, memory_bytes: 400_000_000 };

function interleave(lexical, vector, maxRoots, maxAttempts) {
  const roots = []; let i = 0, j = 0, takeLexical = true;
  for (let attempts = 0; attempts < maxAttempts && roots.length < maxRoots && (i < lexical.length || j < vector.length); attempts++) {
    const lexicalTurn = i < lexical.length && (takeLexical || j >= vector.length);
    takeLexical = !lexicalTurn;
    const id = lexicalTurn ? lexical[i++] : vector[j++];
    if (!roots.includes(id)) roots.push(id);
  }
  return roots;
}

const scratch = mkdtempSync(join(tmpdir(), "roots-sweep-")), out = [];
try {
  for (const row of rows) {
    const question = dataset.get(row.question_id), key = `${row.question_id}/${row.snapshot.split("/").at(-3)}`;
    const file = join(scratch, "snapshot.sqlite"); copyFileSync(row.snapshot, file);
    const connection = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const database = new storage.StorageDatabase(file, connection);
      const workspace = connection.prepare("SELECT workspace_id FROM source_index_selections").pluck().get();
      const goldIds = new Set();
      question.haystack_sessions.forEach((session, s) => session.forEach((turn, t) => {
        if (turn.has_answer) goldIds.add(`${row.question_id}:s${s}:m${t}`);
      }));
      const gold = connection.prepare("SELECT record_id, canonical_inventory FROM source_host_inventories WHERE workspace_id=?").all(workspace)
        .filter(r => JSON.parse(r.canonical_inventory).occurrences.some(o => goldIds.has(o.occurrence_id))).map(r => r.record_id);
      if (gold.length === 0) continue;
      const acquisition = new core.SourceIndexAcquisition(
        new storage.SqliteSourceIndexRepository(database, core.fieldContractSha256, { captureReadTargets: true }), core.fieldContractSha256);
      const vector = { ...vectors[key], embedding: Float32Array.from(vectors[key].embedding) };
      const captured = connection.transaction(() => acquisition.captureNative({ workspace_id: workspace, navigation_text: question.question,
        vector, allowance: { max_attempts: 128, max_roots: 128, max_vector_windows: 4096 }, budget: unlimited },
        () => "admitted", "original", true, "dual"))();
      const lexical = captured.lexical.map(c => c.source.target.root_id);
      const byVector = [...new Set(captured.vector.map(c => c.source.target.root_id))];
      const result = { question_id: row.question_id, question_type: row.question_type, gold: gold.length,
        matches_run: JSON.stringify(interleave(lexical, byVector, 16, 128))
          === JSON.stringify(native[key]?.large?.identity?.nominations?.map(n => JSON.parse(n.root_key).root_id)) };
      for (const R of ROOTS) {
        // Past 16 roots the 128-attempt cap would bind first; lift it to see membership alone.
        const nominated = interleave(lexical, byVector, R, R === 16 ? 128 : Infinity);
        const ranks = gold.map(g => nominated.indexOf(g) + 1).filter(rank => rank > 0);
        result[R] = { in: ranks.length, last: ranks.length === gold.length ? Math.max(...ranks) : null };
      }
      out.push(result);
    } finally { connection.close(); rmSync(file, { force: true }); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

console.log(`replay equals the run's 16 nominations: ${out.filter(r => r.matches_run).length}/${out.length}`);
for (const R of ROOTS) {
  console.log(`max_roots ${R}: gold roots ${out.reduce((n, r) => n + r[R].in, 0)}/${out.reduce((n, r) => n + r.gold, 0)}, ` +
    `Any ${out.filter(r => r[R].in > 0).length}, All ${out.filter(r => r[R].in === r.gold).length} of ${out.length}`);
}
const short = out.filter(r => r[16].in < r.gold);
console.log(`All misses at 16: ${short.length}`, JSON.stringify(short.reduce((m, r) => ({ ...m, [r.question_type]: (m[r.question_type] ?? 0) + 1 }), {})),
  `; recovered at ${ROOTS.slice(1).join("/")}: ${ROOTS.slice(1).map(R => short.filter(r => r[R].in === r.gold).length).join("/")}`,
  `; last gold rank at 128: ${JSON.stringify(short.map(r => r[128].last))}`);
