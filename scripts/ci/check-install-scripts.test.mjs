#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installScript = path.join(repoRoot, "scripts/install.sh");
const vacuumScript = path.join(repoRoot, "scripts/vacuum-into.mjs");
const locatorScript = path.join(repoRoot, "scripts/resolve-live-db-path.mjs");

function locateLiveDb(env) {
  const result = spawnSync(process.execPath, [locatorScript], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim();
  const tab = line.indexOf("\t");
  assert.notEqual(tab, -1, `locator output missing tab: ${line}`);
  return { configDir: line.slice(0, tab), dbPath: line.slice(tab + 1) };
}

test("install.sh prints a pnpm 12-compatible optional embedding command", () => {
  const source = readFileSync(installScript, "utf8");
  assert.doesNotMatch(source, /pnpm add .*--no-frozen-lockfile/);
  assert.match(
    source,
    /pnpm --dir \\"\$\{ALAYA_HOME\}\\" add @huggingface\/transformers@4\.2\.0 --filter @do-soul\/alaya-core/
  );
});

test("install.sh rejects a tarball whose package.json version does not match the tag", () => {
  const work = mkdtempSync(path.join(tmpdir(), "alaya-install-version-"));
  try {
    const prefix = path.join(work, "do-soul-alaya-0.3.11");
    mkdirSync(prefix);
    writeFileSync(path.join(prefix, "package.json"), `${JSON.stringify({ name: "do-soul-alaya", version: "0.0.0" }, null, 2)}\n`);
    const tarball = path.join(work, "do-soul-alaya-0.3.11.tar.gz");
    const tar = spawnSync("tar", ["-czf", tarball, "do-soul-alaya-0.3.11"], { cwd: work, encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const sums = path.join(work, "SHA256SUMS");
    writeFileSync(sums, `${digest}  do-soul-alaya-0.3.11.tar.gz\n`);

    const result = spawnSync("bash", [installScript], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        ALAYA_VERSION: "v0.3.11",
        ALAYA_LOCAL_TARBALL: tarball,
        ALAYA_LOCAL_SHA256SUMS: sums,
        ALAYA_HOME: path.join(work, "home"),
        ALAYA_BIN_DIR: path.join(work, "bin")
      }
    });
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /package\.json version/);
    assert.match(output, /does not match tag/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("live db locator follows ALAYA_CONFIG_DIR then XDG_CONFIG_HOME then ~/.config/alaya", () => {
  const work = mkdtempSync(path.join(tmpdir(), "alaya-locator-"));
  try {
    const home = path.join(work, "home");
    const xdg = path.join(work, "xdg");
    const override = path.join(work, "override");
    mkdirSync(home);
    mkdirSync(xdg);
    mkdirSync(override);

    const fromXdg = locateLiveDb({
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      ALAYA_CONFIG_DIR: "",
      DATA_DIR: ""
    });
    assert.equal(fromXdg.configDir, path.join(xdg, "alaya"));
    assert.equal(fromXdg.dbPath, path.join(xdg, "alaya", "alaya.db"));

    const fromOverride = locateLiveDb({
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      ALAYA_CONFIG_DIR: override,
      DATA_DIR: ""
    });
    assert.equal(fromOverride.configDir, override);
    assert.equal(fromOverride.dbPath, path.join(override, "alaya.db"));

    const fromHome = locateLiveDb({
      HOME: home,
      XDG_CONFIG_HOME: "",
      ALAYA_CONFIG_DIR: "",
      DATA_DIR: ""
    });
    assert.equal(fromHome.configDir, path.join(home, ".config", "alaya"));
    assert.equal(fromHome.dbPath, path.join(home, ".config", "alaya", "alaya.db"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("live db locator resolves relative toml and DATA_DIR against the config dir", () => {
  const work = mkdtempSync(path.join(tmpdir(), "alaya-locator-rel-"));
  try {
    const configDir = path.join(work, "xdg", "alaya");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "alaya.toml"), "[storage]\ndb_path = \"data/live.db\"\n");

    const fromToml = locateLiveDb({
      HOME: path.join(work, "home"),
      XDG_CONFIG_HOME: path.join(work, "xdg"),
      ALAYA_CONFIG_DIR: "",
      DATA_DIR: "ignored-when-toml-present"
    });
    assert.equal(fromToml.configDir, configDir);
    assert.equal(fromToml.dbPath, path.join(configDir, "data", "live.db"));

    rmSync(path.join(configDir, "alaya.toml"));
    const fromDataDir = locateLiveDb({
      HOME: path.join(work, "home"),
      XDG_CONFIG_HOME: path.join(work, "xdg"),
      ALAYA_CONFIG_DIR: "",
      DATA_DIR: "relative-data"
    });
    assert.equal(fromDataDir.dbPath, path.join(configDir, "relative-data", "alaya.db"));

    const absoluteData = path.join(work, "abs-data");
    const fromAbsolute = locateLiveDb({
      HOME: path.join(work, "home"),
      XDG_CONFIG_HOME: path.join(work, "xdg"),
      ALAYA_CONFIG_DIR: "",
      DATA_DIR: absoluteData
    });
    assert.equal(fromAbsolute.dbPath, path.join(absoluteData, "alaya.db"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("vacuum-into.mjs writes a restorable snapshot", async () => {
  const { default: Database } = await import("better-sqlite3");
  const work = mkdtempSync(path.join(tmpdir(), "alaya-vacuum-"));
  try {
    const source = path.join(work, "alaya.db");
    const dest = path.join(work, "backups", "alaya-v0.3.11-test.db");
    const db = new Database(source);
    db.exec("CREATE TABLE memory (id TEXT PRIMARY KEY, body TEXT); INSERT INTO memory VALUES ('1', 'hello');");
    db.close();

    const result = spawnSync(process.execPath, [vacuumScript, source, dest], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(dest), true);

    const restored = new Database(dest, { readonly: true });
    const row = restored.prepare("SELECT body FROM memory WHERE id = '1'").get();
    restored.close();
    assert.equal(row.body, "hello");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
