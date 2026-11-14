import BetterSqlite3 from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireTemporalRuntimeLease } from "../../runtime/temporal-cutover/lease.js";
import { quoteTomlString } from "../support/test-paths.js";

const bin = fileURLToPath(new URL("../../../../../bin/alaya.mjs", import.meta.url));
const preload = new URL("../support/cli-bootstrap-tripwire.mjs", import.meta.url).href;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "alaya-bin-import-")));
  directories.push(root);
  const config = path.join(root, "config");
  const home = path.join(root, "home");
  mkdirSync(config); mkdirSync(home);
  const witness = path.join(root, "transport-attempts");
  writeFileSync(witness, "");
  const bundlePath = path.join(root, "bundle.json");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, APPVEYOR: "1", CI: "1",
    ALAYA_CONFIG_DIR: config, ALAYA_TEST_TRANSPORT_WITNESS: witness,
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1"
  };
  const incoming = new BetterSqlite3(":memory:");
  incoming.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('incoming')");
  const bytes = incoming.serialize(); incoming.close();
  const bundledTarget = path.join(root, "must-not-restore.db");
  const bundle = {
    bundle_version: 1, kind: "backup", created_at: "2026-11-13T00:00:00.000Z",
    config: { alaya_toml: `[storage]\ndb_path = ${quoteTomlString(bundledTarget)}\n`, env_file: null as string | null },
    storage: { db_path: bundledTarget, db_base64: bytes.toString("base64") as string | null }
  };
  const save = () => writeFileSync(bundlePath, JSON.stringify(bundle));
  save();
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", preload, bin, ...args], {
      cwd: root, env, encoding: "utf8", timeout: 30_000
    });
    expect(result.error).toBeUndefined();
    return result;
  };
  return { root, config, env, bundle, bundlePath, bundledTarget, save, run, witness };
}

function writeDb(filename: string) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const db = new BetterSqlite3(filename);
  try { db.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('keep')"); }
  finally { db.close(); }
}
function value(filename: string) {
  const db = new BetterSqlite3(filename, { readonly: true });
  try { return db.prepare("SELECT value FROM example").get(); } finally { db.close(); }
}

it.each(["default", "DATA_DIR", "toml"])("real bin imports into the %s target without normal runtime startup", mode => {
  const f = fixture();
  let target = path.join(f.config, "alaya.db");
  if (mode === "DATA_DIR") {
    f.env.DATA_DIR = "relative data";
    target = path.join(f.root, "relative data/alaya.db");
  }
  if (mode === "toml") {
    f.env.DATA_DIR = "ignored-data";
    target = path.join(f.root, "configured data/live.db");
    writeFileSync(path.join(f.config, "alaya.toml"), '[storage]\ndb_path = "configured data/live.db"\n');
  }
  writeDb(target);
  const preview = f.run(["import", f.bundlePath, "--preview", "--json"]);
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ has_database_payload: true });
  expect(value(target)).toEqual({ value: "keep" });
  expect(f.run(["import", f.bundlePath]).status).toBe(64);
  const imported = f.run(["import", f.bundlePath, "--yes", "--json"]);
  expect(imported.status, imported.stderr).toBe(0);
  expect(JSON.parse(imported.stdout).restored_paths).toContain(target);
  expect(value(target)).toEqual({ value: "incoming" });
  expect(existsSync(f.bundledTarget)).toBe(false);
  expect(readFileSync(path.join(f.config, "alaya.toml"), "utf8")).toContain(quoteTomlString(target));
  expect(readFileSync(f.witness, "utf8")).toBe("");
}, 40_000);

it("real bin refuses another process's runtime lease, then succeeds after release", async () => {
  const f = fixture();
  f.env.DATA_DIR = "data";
  const target = path.join(f.root, "data/alaya.db");
  writeDb(target);
  const lease = await acquireTemporalRuntimeLease(target);
  try {
    const refused = f.run(["import", f.bundlePath, "--yes"]);
    expect(refused.status).not.toBe(0);
    expect(value(target)).toEqual({ value: "keep" });
    expect(existsSync(path.join(f.config, "alaya.toml"))).toBe(false);
  } finally { await lease.release(); }
  const imported = f.run(["import", f.bundlePath, "--yes"]);
  expect(imported.status, imported.stderr).toBe(0);
  expect(value(target)).toEqual({ value: "incoming" });
}, 40_000);

it("real bin releases maintenance leases after invalid SQLite and records failure without mutation", () => {
  const f = fixture();
  const target = path.join(f.config, "alaya.db");
  writeDb(target);
  const validPayload = f.bundle.storage.db_base64;
  f.bundle.storage.db_base64 = Buffer.from("not SQLite").toString("base64"); f.save();
  const failed = f.run(["import", f.bundlePath, "--yes"]);
  expect(failed.status).not.toBe(0);
  expect(value(target)).toEqual({ value: "keep" });
  expect(existsSync(path.join(f.config, "alaya.toml"))).toBe(false);
  const audits = readdirSync(path.join(f.config, "audit"));
  expect(audits).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(f.config, "audit", audits[0]!), "utf8")))
    .toMatchObject({ status: "failed", partial_state: [] });
  f.bundle.storage.db_base64 = validPayload; f.save();
  const retry = f.run(["import", f.bundlePath, "--yes"]);
  expect(retry.status, retry.stderr).toBe(0);
  expect(value(target)).toEqual({ value: "incoming" });
}, 40_000);

it("real bin audits a partial restore and releases leases after a filesystem publication failure", () => {
  const f = fixture();
  const target = path.join(f.config, "alaya.db");
  const toml = path.join(f.config, "alaya.toml");
  const envPath = path.join(f.config, ".env");
  writeDb(target);
  f.bundle.config.env_file = "RESTORED=yes\n"; f.save();
  mkdirSync(envPath); // Atomic file publication must refuse this existing directory.
  const failed = f.run(["import", f.bundlePath, "--yes"]);
  expect(failed.status).not.toBe(0);
  expect(value(target)).toEqual({ value: "incoming" });
  const audits = readdirSync(path.join(f.config, "audit"));
  expect(JSON.parse(readFileSync(path.join(f.config, "audit", audits[0]!), "utf8")))
    .toMatchObject({ status: "failed", partial_state: [target, toml] });
  rmSync(envPath, { recursive: true });
  const retry = f.run(["import", f.bundlePath, "--yes"]);
  expect(retry.status, retry.stderr).toBe(0);
  expect(readFileSync(envPath, "utf8")).toBe("RESTORED=yes\n");
  expect(value(target)).toEqual({ value: "incoming" });
}, 40_000);

it.each(["current", "selected"])("config-only import requires the %s database to be stopped", async held => {
  const f = fixture();
  const current = path.join(f.config, "alaya.db");
  writeDb(current); writeDb(f.bundledTarget);
  f.bundle.storage.db_base64 = null; f.save();
  const lease = await acquireTemporalRuntimeLease(held === "current" ? current : f.bundledTarget);
  try {
    expect(f.run(["import", f.bundlePath, "--yes"]).status).not.toBe(0);
    expect(existsSync(path.join(f.config, "alaya.toml"))).toBe(false);
  } finally { await lease.release(); }
  const imported = f.run(["import", f.bundlePath, "--yes", "--json"]);
  expect(imported.status, imported.stderr).toBe(0);
  expect(JSON.parse(imported.stdout).restored_paths).toEqual([path.join(f.config, "alaya.toml")]);
  expect(readFileSync(path.join(f.config, "alaya.toml"), "utf8")).toBe(f.bundle.config.alaya_toml);
  expect(value(current)).toEqual({ value: "keep" });
  expect(value(f.bundledTarget)).toEqual({ value: "keep" });
}, 40_000);

it.each(["doctor", "status", "--help"])("real bin %s omits unneeded embedding bootstrap probes", command => {
  const f = fixture();
  f.env.ALAYA_TEST_EMBEDDING_CAPABILITY = "1";
  f.env.ALAYA_EMBEDDING_PROVIDER = "openai";
  f.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "1";
  f.env.OPENAI_EMBEDDING_PROVIDER_URL = "https://provider.invalid/v1";
  const health = f.run([command, "--json"]);
  expect(health.stdout, health.stderr).not.toBe("");
  if (command === "--help") expect(health.stdout).toContain("Usage:");
  else expect(() => JSON.parse(health.stdout)).not.toThrow();
  expect(readFileSync(f.witness, "utf8")).toBe("");
  // Positive control: recall-capable bootstrap still requests its eager probe.
  const ordinary = f.run(["tools", "list", "--json"]);
  expect(ordinary.status, ordinary.stderr).toBe(0);
  expect(readFileSync(f.witness, "utf8")).toContain("transport attempted");
}, 60_000);
