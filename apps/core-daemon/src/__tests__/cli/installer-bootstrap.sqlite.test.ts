import BetterSqlite3 from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireTemporalRuntimeLease } from "../../runtime/temporal-cutover/lease.js";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const installer = path.join(repo, "scripts/install.sh");
const preload = new URL("../support/cli-bootstrap-tripwire.mjs", import.meta.url).href;
const directories: string[] = [];
let release: ReturnType<typeof packageBuiltRelease>;
afterAll(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

// Reuse external dependencies read-only, but bind every workspace dependency to
// the copied release tree. No staged package resolves to another tree's dist.
function linkDependencies(source: string, destination: string, releaseRoot: string) {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      linkDependencies(path.join(source, entry), path.join(destination, entry), releaseRoot);
      continue;
    }
    const resolved = realpathSync(path.join(source, entry));
    const relative = path.relative(repo, resolved);
    const workspace = relative.startsWith(`packages${path.sep}`) || relative.startsWith(`apps${path.sep}`);
    expect(workspace || relative.startsWith(`node_modules${path.sep}`)).toBe(true);
    if (path.basename(source) === "@do-soul") expect(workspace).toBe(true);
    const target = workspace ? path.relative(destination, path.join(releaseRoot, relative)) : resolved;
    symlinkSync(target, path.join(destination, entry), "dir");
  }
}

function packageBuiltRelease() {
  const root = temporaryDirectory("alaya-built-installer-release-");
  const name = "do-soul-alaya-0.3.11";
  const tree = path.join(root, name);
  mkdirSync(tree);
  copyFileSync(path.join(repo, "package.json"), path.join(tree, "package.json"));
  for (const relative of ["bin", "scripts"]) {
    mkdirSync(path.join(tree, relative));
  }
  copyFileSync(path.join(repo, "bin/alaya.mjs"), path.join(tree, "bin/alaya.mjs"));
  for (const script of ["configured-paths.mjs", "resolve-live-db-path.mjs", "vacuum-into.mjs"]) {
    copyFileSync(path.join(repo, "scripts", script), path.join(tree, "scripts", script));
  }
  const packages = ["apps/core-daemon", "apps/inspector",
    ...readdirSync(path.join(repo, "packages")).map(name => `packages/${name}`)];
  for (const relative of packages) {
    const source = path.join(repo, relative);
    const destination = path.join(tree, relative);
    mkdirSync(destination, { recursive: true });
    copyFileSync(path.join(source, "package.json"), path.join(destination, "package.json"));
    cpSync(path.join(source, "dist"), path.join(destination, "dist"), { recursive: true });
    linkDependencies(path.join(source, "node_modules"), path.join(destination, "node_modules"), tree);
  }
  const promptAssets = "packages/soul/src/garden/ingestion/official-api/historical-prompts";
  cpSync(path.join(repo, promptAssets), path.join(tree, promptAssets), { recursive: true });
  linkDependencies(path.join(repo, "node_modules"), path.join(tree, "node_modules"), tree);
  const tarball = path.join(root, `${name}.tar.gz`);
  const packed = spawnSync("tar", ["-czf", tarball, name], { cwd: root, encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);
  const sums = path.join(root, "SHA256SUMS");
  writeFileSync(sums, `${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ${name}.tar.gz\n`);
  return { tarball, sums };
}

function fixture(mode: "toml" | "DATA_DIR") {
  const root = temporaryDirectory("alaya-installer-live-bootstrap-");
  const launch = path.join(root, "launch directory");
  const home = path.join(root, "home");
  const commands = path.join(root, "commands");
  const config = path.join(launch, "config relative");
  const installHome = path.join(launch, "installation tree");
  for (const directory of [launch, home, commands, config, installHome]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(installHome, "sentinel"), "retained old install");
  const target = path.join(launch, "live data", mode === "toml" ? "configured.db" : "alaya.db");
  mkdirSync(path.dirname(target));
  const db = new BetterSqlite3(target);
  // An identifiable, valid uninitialized SQLite file is eligible for bootstrap.
  db.pragma("application_id = 246813579");
  db.close();
  if (mode === "toml") writeFileSync(path.join(config, "alaya.toml"), '[storage]\ndb_path = "live data/configured.db"\n');
  const transportWitness = path.join(root, "transport-attempts");
  const toolWitness = path.join(root, "install-tools");
  writeFileSync(transportWitness, "");
  // Only dependency/build setup is substituted. Locator, VACUUM INTO, production
  // bin, full runtime/bootstrap and SQLite migration/lease checks remain real.
  writeFileSync(path.join(commands, "pnpm"), '#!/bin/sh\ncase "$*" in\n--version) printf "12.3.4\\n" ;;\n"install --frozen-lockfile"|build) printf "%s\\n" "$*" >> "$ALAYA_TEST_INSTALL_TOOL_LOG" ;;\n*) exit 2 ;;\nesac\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: `${commands}${path.delimiter}${process.env.PATH}`, HOME: home,
    APPVEYOR: "1", CI: "1", NODE_OPTIONS: `--import=${preload}`,
    ALAYA_VERSION: "v0.3.11", ALAYA_LOCAL_TARBALL: release.tarball,
    ALAYA_LOCAL_SHA256SUMS: release.sums, ALAYA_HOME: "installation tree",
    ALAYA_BIN_DIR: "launcher directory", ALAYA_CONFIG_DIR: "config relative",
    DATA_DIR: mode === "toml" ? "ignored data" : "live data",
    ALAYA_TEST_INSTALL_TOOL_LOG: toolWitness, ALAYA_TEST_TRANSPORT_WITNESS: transportWitness,
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1"
  };
  const run = () => {
    const result = spawnSync("bash", [installer], { cwd: launch, env, encoding: "utf8", timeout: 40_000 });
    expect(result.error).toBeUndefined();
    expect(readFileSync(transportWitness, "utf8")).toBe("");
    expect(readFileSync(toolWitness, "utf8")).toBe("install --frozen-lockfile\nbuild\n");
    return result;
  };
  const backup = () => {
    const files = readdirSync(path.join(config, "backups"));
    expect(files).toHaveLength(1);
    return path.join(config, "backups", files[0]!);
  };
  return { launch, config, target, installHome, run, backup };
}

function schemaWitness(filename: string) {
  const db = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
  try {
    return {
      identity: db.pragma("application_id", { simple: true }),
      schema: db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_version'").all()
    };
  } finally { db.close(); }
}

// install.sh is a POSIX installer; Windows release bootstrap remains a separate gate.
describe.skipIf(process.platform === "win32")("installer production bin launch context", () => {
  beforeAll(() => { release = packageBuiltRelease(); });

  it.each(["toml", "DATA_DIR"] as const)("snapshots and migrates the same relative %s target without a staged ghost DB", mode => {
    const f = fixture(mode);
    expect(schemaWitness(f.target)).toEqual({ identity: 246813579, schema: [] });
    const installed = f.run();
    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
    expect(installed.stdout).toContain(`backing up ${realpathSync(f.target)} -> `);
    expect(schemaWitness(f.backup())).toEqual({ identity: 246813579, schema: [] });
    expect(schemaWitness(f.target)).toEqual({ identity: 246813579, schema: [{ name: "schema_version" }] });
    const current = new BetterSqlite3(f.target, { readonly: true });
    try { expect(current.prepare("SELECT version FROM schema_version WHERE version = 45").get()).toEqual({ version: 45 }); }
    finally { current.close(); }
    expect(readFileSync(path.join(`${f.installHome}.bak`, "sentinel"), "utf8")).toBe("retained old install");
    expect(readdirSync(f.installHome, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".db"))).toEqual([]);
    expect(readdirSync(f.launch).some(name => name.includes(".staging-"))).toBe(false);
    expect(existsSync(path.join(f.launch, "ignored data"))).toBe(false);
  }, 60_000);

  it.each(["toml", "DATA_DIR"] as const)("refuses another process's lease on the snapshotted relative %s target before migrating or swapping", async mode => {
    const f = fixture(mode);
    const before = readFileSync(f.target);
    const lease = await acquireTemporalRuntimeLease(f.target);
    try {
      const refused = f.run();
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("post-build sanity check failed");
      expect(readFileSync(f.target)).toEqual(before);
      expect(schemaWitness(f.backup())).toEqual({ identity: 246813579, schema: [] });
      expect(readFileSync(path.join(f.installHome, "sentinel"), "utf8")).toBe("retained old install");
      expect(existsSync(`${f.installHome}.bak`)).toBe(false);
      expect(readdirSync(f.installHome, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".db"))).toEqual([]);
      expect(readdirSync(f.launch).some(name => name.includes(".staging-"))).toBe(false);
    } finally { await lease.release(); }
  }, 60_000);
});
