import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const guard = fileURLToPath(new URL("../../support/source-import-boundary.mjs", import.meta.url));
const prepare = new URL("../../../../dist/runs/snapshot/source-records/prepare.js", import.meta.url).href;
const artifact = new URL("../../../../dist/runs/snapshot/source-records/contract.js", import.meta.url).href;
const storage = new URL("../../../../../../packages/storage/dist/index.js", import.meta.url).href;

// The fixture process uses built application modules, file-backed native SQLite,
// real MCP installation/attachment, the audited source writer and real read worker.
const importProgram = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
const [root, prepareURL, artifactURL, guardURL, storageURL] = process.argv.slice(1);
const { receipt } = await import(guardURL);
const require = createRequire(prepareURL);
const resolved = require.resolve("@huggingface/transformers");
assert.match(resolved, /transformers/);
const leases = [];
const mkdir = fsp.mkdir;
fsp.mkdir = async function(path, ...rest) {
  const config = /^alaya-bench-config-/u.test(basename(String(path)));
  if (config) assert.equal(dirname(String(path)), root);
  const existed = config && fs.existsSync(path);
  const result = await Reflect.apply(mkdir, this, [path, ...rest]);
  // Config writers also mkdir the existing parent. Count actual child creation,
  // not repeated idempotent mkdir calls within the same owned lease.
  if (config && !existed && !leases.includes(String(path))) {
    assert(fs.statSync(path).isDirectory());
    leases.push(String(path));
  }
  return result;
};
syncBuiltinESMExports();
// Establish disagreeing ambient values after credential removal. Import effects
// must override them for setup, then restore them without changing native TMPDIR.
process.env.ALAYA_SQLITE_WRITE_QUEUE = "1";
process.env.ALAYA_GARDEN_PROVIDER_KIND = "host_worker";
process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER = "true";
const saved = { ...process.env };
const { prepareSourceRecordsSnapshot } = await import(prepareURL);
const { inspectSourceRecordsArtifact, sourceRecordsManifestPath } = await import(artifactURL);
const { openReadOnlyDatabase, SqliteEventLogRepo } = await import(storageURL);
const effects = { configDirectoryRoot: root, sqliteWriteQueue: "disabled",
  embeddingStartupProbe: "omit", gardenCompute: "disabled" };
function fixture(name, bad = false) {
  const directory = join(root, name); fs.mkdirSync(directory);
  const data = join(directory, "dataset"), meta = join(directory, "meta");
  fs.mkdirSync(data); fs.mkdirSync(meta);
  const source = JSON.stringify([{ question_id: "authored-question", question_type: "fixture",
    question: "What was recorded?", answer: "unused scoring metadata", question_date: "2023/09/13 (Wed) 00:00",
    haystack_session_ids: ["first", bad ? "" : "second"],
    haystack_dates: ["2023/09/12 (Tue) 00:00", "2023/09/12 (Tue) 00:00"], answer_session_ids: [],
    haystack_sessions: [[{ role: "user", content: "A small authored source." }, { role: "assistant", content: "Noted." }],
      [{ role: "user", content: "" }]] }]);
  fs.writeFileSync(join(data, "longmemeval_s.json"), source);
  fs.writeFileSync(join(meta, "longmemeval_s.meta.json"), JSON.stringify({
    sha256: createHash("sha256").update(source).digest("hex"), size_bytes: Buffer.byteLength(source), question_count: 1 }));
  return { snapshotPath: join(directory, "sources.sqlite"), dataDirRoot: join(directory, "live"),
    dataDir: data, pinnedMetaRoot: meta, offset: 0, limit: 1, recordedAt: "2026-09-13T00:00:00.000Z",
    producerCommit: "a".repeat(40), importEffects: effects };
}
function restored() {
  for (const key of new Set([...Object.keys(saved), ...Object.keys(process.env)])) assert.equal(process.env[key], saved[key], key);
  for (const path of leases) assert.equal(fs.existsSync(path), false, path);
}
function state(filename) {
  const storage = openReadOnlyDatabase(filename);
  const db = storage.connection;
  try {
    const count = table => db.prepare("SELECT count(*) AS n FROM " + table).get().n;
    return { sources: db.prepare("SELECT record_id, source_body, evidence_object_id FROM source_records ORDER BY source_body").all(),
      audits: db.prepare("SELECT count(*) AS n FROM event_log WHERE entity_type='source_record'").get().n,
      memory: count("memory_entries"), capsules: count("evidence_capsules"), garden: count("garden_tasks"),
      rebuilds: count("field_projection_rebuild_requests"), generations: count("projection_generation_pointer"),
      integrity: db.pragma("integrity_check", { simple: true }) };
  } finally { storage.close(); }
}
const success = fixture("success");
const sealed = await prepareSourceRecordsSnapshot(success);
restored();
const messages = [];
const verified = inspectSourceRecordsArtifact(success.snapshotPath, row => messages.push(row));
assert.deepEqual(sealed, verified.manifest);
assert.equal(messages.length, 3);
// Assert freeze quiescence before a normal readonly SQLite inspection can create
// its own WAL/SHM coordination files for this WAL-mode database.
for (const suffix of ["-wal", "-shm"]) assert.equal(fs.existsSync(success.snapshotPath + suffix), false);
const sourceState = state(success.snapshotPath);
assert.deepEqual(sourceState.sources.map(row => row.source_body), ["", "A small authored source.", "Noted."]);
assert(sourceState.sources.every(row => row.evidence_object_id === null));
assert.deepEqual(sourceState.sources.map(row => row.record_id).sort(), messages.map(row => row.record.identity).sort());
assert.equal(sourceState.audits, 3);
assert.equal(sourceState.memory, 0); assert.equal(sourceState.capsules, 0); assert.equal(sourceState.garden, 0);
assert.equal(sourceState.rebuilds, 0); assert(sourceState.generations > 0);
assert.equal(sourceState.integrity, "ok");
// Placement/effect choices are not retained source identity. A sealed snapshot
// remains reusable with the original API and does not launch another daemon.
assert.deepEqual(await prepareSourceRecordsSnapshot({ ...success, importEffects: undefined }), sealed);
assert.equal(leases.length, 1);
const failure = fixture("failure", true);
await assert.rejects(prepareSourceRecordsSnapshot(failure), /source session identity is missing/);
restored();
assert.equal(leases.length, 2);
assert.equal(fs.existsSync(sourceRecordsManifestPath(failure.snapshotPath)), false);
assert.equal(fs.existsSync(failure.snapshotPath), false);
const partial = state(join(failure.dataDirRoot, "alaya.db"));
assert.equal(partial.sources.length, 2); assert.equal(partial.audits, 2);
assert(partial.rebuilds > 0); assert.equal(partial.integrity, "ok");
// Inject only an audit-write refusal. Source admission still runs through the
// ordinary writer and commits its real source receipt before this audit fault.
const fault = fixture("audit-failure");
const append = SqliteEventLogRepo.prototype.append;
SqliteEventLogRepo.prototype.append = function(event) {
  if (event.entity_type === "source_record") throw new Error("fixture source audit write refused");
  return append.call(this, event);
};
try { await assert.rejects(prepareSourceRecordsSnapshot(fault), /fixture source audit write refused/); }
finally { SqliteEventLogRepo.prototype.append = append; }
restored();
assert.equal(leases.length, 3);
assert.equal(fs.existsSync(sourceRecordsManifestPath(fault.snapshotPath)), false);
assert.equal(fs.existsSync(fault.snapshotPath), false);
const committedBeforeAudit = state(join(fault.dataDirRoot, "alaya.db"));
assert.equal(committedBeforeAudit.sources.length, 1); assert.equal(committedBeforeAudit.audits, 0);
assert(committedBeforeAudit.rebuilds > 0); assert.equal(committedBeforeAudit.integrity, "ok");
const recovered = await prepareSourceRecordsSnapshot(fault);
restored();
assert.equal(recovered.message_count, 3);
const recoveredState = state(fault.snapshotPath);
assert.deepEqual(recoveredState.sources.map(({ source_body, evidence_object_id }) => ({ source_body, evidence_object_id })),
  sourceState.sources.map(({ source_body, evidence_object_id }) => ({ source_body, evidence_object_id })));
assert(recoveredState.sources.some(row => row.record_id === committedBeforeAudit.sources[0].record_id));
assert.equal(recoveredState.audits, 3); assert.equal(recoveredState.rebuilds, 0);
assert(recoveredState.generations > 0); assert.equal(recoveredState.integrity, "ok");
assert.equal(leases.length, 4);
// Unsupported configuration is rejected before dataset loading or publish locks.
const unsupported = { ...success, snapshotPath: join(root, "unsupported.sqlite"),
  dataDirRoot: join(root, "unsupported"), dataDir: join(root, "absent-dataset"),
  importEffects: { ...effects, sqliteWriteQueue: "enabled" } };
await assert.rejects(prepareSourceRecordsSnapshot(unsupported));
assert.equal(fs.existsSync(unsupported.dataDirRoot), false);
assert.equal(fs.existsSync(unsupported.snapshotPath + ".lock"), false);
assert.equal(leases.length, 4);
const evidence = receipt();
assert.equal(evidence.credential_file_violations.length, 0);
assert.equal(evidence.operations.some(row => row.blocked), false);
assert(evidence.operations.some(row => row.operation === "package.resolve.metadata" && row.specifier === "@huggingface/transformers"));
assert.equal(evidence.operations.filter(row => row.operation === "worker.create.allowed").length, 4);
const git = evidence.operations.filter(row => row.operation === "process.execFile.read-only-git.allowed");
assert.equal(git.length, 4);
assert(git.every(row => row.credential_environment_count === 0 && row.inherited_git_config === false &&
  row.inherited_loader_environment === false && isAbsolute(row.executable)));
console.log("IMPORT_RECEIPT " + JSON.stringify({ manifest: sealed, sourceState, partial,
  committedBeforeAudit, recovered: { manifest: recovered, state: recoveredState }, leases, guard: evidence }));
`;

function run(program: string, args: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, SOURCE_IMPORT_FIXTURE_SECRET: "must-be-filtered" };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ["--import", guard, "--input-type=module", "--eval", program, ...args], {
    env, encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024
  });
}

it("imports authored source records and cleans the explicit lease on successful sealing and partial failure without model execution", () => {
  const root = mkdtempSync(join(tmpdir(), "source-import-lifecycle-"));
  try {
    const result = run(importProgram, [root, prepare, artifact, new URL(`file://${guard}`).href, storage]);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find(row => row.startsWith("IMPORT_RECEIPT "));
    expect(line, result.stdout).toBeDefined();
    // Preserve a bounded observable native receipt in the test log.
    console.info(line);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 100_000);

it.each([
  ["real model import", `const { createRequire } = await import("node:module");
    const require = createRequire(${JSON.stringify(prepare)});
    await import(require.resolve("@huggingface/transformers"))`, "model-provider.module.load"],
  ["model worker", `const { Worker } = await import("node:worker_threads"); new Worker(new URL("file:///forbidden-model-worker.js"))`, "worker.create"],
  ["SQLite write queue worker", `const { Worker } = await import("node:worker_threads");
    new Worker(new URL(${JSON.stringify(new URL("../../../../../../packages/storage/dist/sqlite/write-queue/worker.js", import.meta.url).href)}))`, "worker.create"],
  ["provider transport", `await fetch("https://provider.invalid")`, "fetch.fetch"],
  ["subprocess", `const cp = await import("node:child_process"); cp.spawn("forbidden")`, "process.spawn"],
  ["credential file", `const fs = await import("node:fs"); fs.readFileSync("/forbidden/credentials.json")`, "credential file"],
  ["native model addon", `process.dlopen({}, process.execPath)`, "native-addon.load"]
])("refuses %s before the actual effect", (_name, program, operation) => {
  const result = run(program);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(operation);
});

it("executes only the pinned read-only Git telemetry query with a credential-free receipt", () => {
  const result = run(`import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { execFile } from "node:child_process";
    const { receipt } = await import(${JSON.stringify(new URL(`file://${guard}`).href)});
    const stdout = await new Promise((resolve, reject) => execFile("git", ["worktree", "list", "--porcelain"], {
      encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH } },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    assert.match(stdout, /^worktree /u);
    const calls = receipt().operations.filter(row => row.operation === "process.execFile.read-only-git.allowed");
    assert.equal(calls.length, 1); assert.equal(calls[0].credential_environment_count, 0);
    assert.equal(calls[0].inherited_git_config, false); assert.equal(calls[0].inherited_loader_environment, false);
    console.log("GIT_RECEIPT " + JSON.stringify({ ...calls[0],
      stdout_bytes: Buffer.byteLength(stdout), stdout_sha256: createHash("sha256").update(stdout).digest("hex") }));`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("GIT_RECEIPT ");
  expect(result.stdout).not.toContain("must-be-filtered");
  console.info(result.stdout.trim());
});

it.each([
  ["extra argument", `"git", ["worktree", "list", "--porcelain", "--all"], {}`],
  ["changed query", `"git", ["status"], {}`],
  ["changed command", `"sh", ["worktree", "list", "--porcelain"], {}`],
  ["shell", `"git", ["worktree", "list", "--porcelain"], { shell: true }`],
  ["credential environment", `"git", ["worktree", "list", "--porcelain"], { env: { FIXTURE_SECRET: "blocked" } }`],
  ["Git config environment", `"git", ["worktree", "list", "--porcelain"], { env: { GIT_CONFIG_GLOBAL: "/forbidden" } }`],
  ["Git hooks config", `"git", ["worktree", "list", "--porcelain"], { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/forbidden" } }`],
  ["native preload environment", `"git", ["worktree", "list", "--porcelain"], { env: { LD_PRELOAD: "/forbidden" } }`],
  ["Node preload environment", `"git", ["worktree", "list", "--porcelain"], { env: { NODE_OPTIONS: "--import=/forbidden" } }`],
  ["executable search override", `"git", ["worktree", "list", "--porcelain"], { env: { PATH: "/forbidden" } }`],
  ["foreign cwd", `"git", ["worktree", "list", "--porcelain"], { cwd: "/" }`]
])("refuses read-only Git %s injection before execution", (_name, invocation) => {
  const result = run(`const { execFile } = await import("node:child_process"); execFile(${invocation}, () => {});`);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("Source import fixture refused process.execFile");
  expect(result.stderr).not.toContain("process.execFile.read-only-git.allowed");
});

it("removes ambient credential values before application imports", () => {
  const result = run(`import assert from "node:assert/strict";
    assert.equal(Object.keys(process.env).some(key => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)), false);`);
  expect(result.status, result.stderr).toBe(0);
});
