#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installScript = path.join(repoRoot, "scripts/install.sh");
const uninstallScript = path.join(repoRoot, "scripts/uninstall.sh");
const vacuumScript = path.join(repoRoot, "scripts/vacuum-into.mjs");
const locatorScript = path.join(repoRoot, "scripts/resolve-live-db-path.mjs");

function runUninstall(work, env, args = []) {
  return spawnSync("bash", [uninstallScript, ...args], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      ALAYA_PURGE_YES: "1",
      ALAYA_DETACH_TARGETS: " ",
      ...env
    }
  });
}

function writeSentinel(dir) {
  mkdirSync(dir, { recursive: true });
  const sentinel = path.join(dir, "sentinel");
  writeFileSync(sentinel, "keep-me");
  return sentinel;
}

function locateLiveDb(env, cwd = repoRoot) {
  const result = spawnSync(process.execPath, [locatorScript], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim();
  const tab = line.indexOf("\t");
  assert.notEqual(tab, -1, `locator output missing tab: ${line}`);
  return { configDir: line.slice(0, tab), dbPath: line.slice(tab + 1) };
}

test("install.sh describes the required ONNX runtime and explicit model provisioning", () => {
  const source = readFileSync(installScript, "utf8");
  const uninstallSource = readFileSync(uninstallScript, "utf8");
  assert.doesNotMatch(source, /ALAYA_BIN_DIR=\/usr\//);
  assert.match(source, /ALAYA_HOME=\/opt\/alaya ALAYA_BIN_DIR=\/opt\/alaya\/bin/);
  assert.match(uninstallSource, /\. "\$SCRIPT_DIR\/install\.sh"/);
  assert.doesNotMatch(uninstallSource, /\beval\b|awk '\/\^reject_unsafe_path/);
  assert.doesNotMatch(source, /pnpm add .*--no-frozen-lockfile/);
  const corePackage = JSON.parse(readFileSync(path.join(repoRoot, "packages/core/package.json"), "utf8"));
  assert.ok(source.includes(`@huggingface/transformers@${corePackage.dependencies["@huggingface/transformers"]}`));
  assert.match(source, /node \$\{ALAYA_HOME\}\/scripts\/fetch-local-embedding-model\.mjs/);
  assert.doesNotMatch(source, /optional; default install skips|@huggingface\/transformers@4\.2\.0/);
  assert.ok(source.indexOf('node ./scripts/vacuum-into.mjs') < source.indexOf('node ./bin/alaya.mjs --help'));
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

test("installer snapshots live storage before invoking the staged CLI bootstrap", () => {
  const work = mkdtempSync(path.join(tmpdir(), "alaya-install-backup-order-"));
  try {
    const prefixName = "do-soul-alaya-0.3.11";
    const prefix = path.join(work, prefixName);
    const fakeBin = path.join(work, "commands");
    const configDir = path.join(work, "config");
    const liveDb = path.join(configDir, "alaya.db");
    mkdirSync(path.join(prefix, "scripts"), { recursive: true });
    mkdirSync(path.join(prefix, "bin"));
    mkdirSync(fakeBin); mkdirSync(configDir);
    writeFileSync(liveDb, "pre-upgrade-storage");
    writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ version: "0.3.11" }));
    writeFileSync(path.join(fakeBin, "pnpm"), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "12.3.4\\n"; fi\n', { mode: 0o755 });
    writeFileSync(path.join(prefix, "scripts/resolve-live-db-path.mjs"),
      'process.stdout.write(process.env.ALAYA_CONFIG_DIR + "\\t" + process.env.FIXTURE_LIVE_DB + "\\n");\n');
    writeFileSync(path.join(prefix, "scripts/vacuum-into.mjs"),
      'import fs from "node:fs"; import path from "node:path"; fs.mkdirSync(path.dirname(process.argv[3]), {recursive:true}); fs.copyFileSync(process.argv[2], process.argv[3]);\n');
    writeFileSync(path.join(prefix, "bin/alaya.mjs"),
      'import fs from "node:fs"; fs.writeFileSync(process.env.FIXTURE_LIVE_DB, "upgraded-by-bootstrap");\n');
    const tarball = path.join(work, `${prefixName}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", tarball, prefixName], { cwd: work, encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    const sums = path.join(work, "SHA256SUMS");
    writeFileSync(sums, `${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ${prefixName}.tar.gz\n`);
    const result = spawnSync("bash", [installScript], { cwd: work, encoding: "utf8", env: {
      ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, HOME: path.join(work, "operator-home"),
      ALAYA_VERSION: "v0.3.11", ALAYA_LOCAL_TARBALL: tarball, ALAYA_LOCAL_SHA256SUMS: sums,
      ALAYA_HOME: path.join(work, "install"), ALAYA_BIN_DIR: path.join(work, "bin"),
      ALAYA_CONFIG_DIR: configDir, FIXTURE_LIVE_DB: liveDb
    } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const backups = readdirSync(path.join(configDir, "backups"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(path.join(configDir, "backups", backups[0]), "utf8"), "pre-upgrade-storage");
    assert.equal(readFileSync(liveDb, "utf8"), "upgraded-by-bootstrap");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("uninstall reports a canceled detach before removing the launcher", () => {
  const work = mkdtempSync(path.join(tmpdir(), "alaya-uninstall-canceled-detach-"));
  try {
    const commands = path.join(work, "commands");
    const install = path.join(work, "install");
    mkdirSync(commands); mkdirSync(install);
    writeFileSync(path.join(commands, "alaya"), '#!/bin/sh\nprintf "canceled\\n"\nexit 77\n', { mode: 0o755 });
    const result = runUninstall(work, {
      PATH: `${commands}${path.delimiter}${process.env.PATH}`, HOME: path.join(work, "operator-home"),
      ALAYA_HOME: install, ALAYA_BIN_DIR: path.join(work, "bin"), ALAYA_CONFIG_DIR: path.join(work, "config"),
      ALAYA_DETACH_TARGETS: "codex"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /detach codex failed/);
    assert.match(result.stderr, /detach failed for: codex/);
    assert.equal(existsSync(install), false);
  } finally { rmSync(work, { recursive: true, force: true }); }
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

test("live db locator resolves relative toml and DATA_DIR against the launch directory", () => {
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
    assert.equal(fromToml.dbPath, path.join(repoRoot, "data", "live.db"));
    const changedCwd = locateLiveDb({ ALAYA_CONFIG_DIR: configDir }, work);
    assert.equal(changedCwd.dbPath, path.join(work, "data", "live.db"));

    rmSync(path.join(configDir, "alaya.toml"));
    const fromDataDir = locateLiveDb({
      HOME: path.join(work, "home"),
      XDG_CONFIG_HOME: path.join(work, "xdg"),
      ALAYA_CONFIG_DIR: "",
      DATA_DIR: "relative-data"
    });
    assert.equal(fromDataDir.dbPath, path.join(repoRoot, "relative-data", "alaya.db"));

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

test("uninstall refuses unsafe destructive targets and preserves sentinels", () => {
  const cases = [
    {
      label: "ALAYA_HOME=$HOME",
      args: [],
      env: (work, home) => ({ ALAYA_HOME: home, ALAYA_BIN_DIR: path.join(work, "bin"), ALAYA_CONFIG_DIR: path.join(work, "config") }),
      refuse: /ALAYA_HOME cannot be \$HOME/
    },
    {
      label: "ALAYA_CONFIG_DIR=$HOME --purge",
      args: ["--purge"],
      env: (work, home) => ({ ALAYA_HOME: path.join(work, "install"), ALAYA_BIN_DIR: path.join(work, "bin"), ALAYA_CONFIG_DIR: home }),
      refuse: /ALAYA_CONFIG_DIR cannot be \$HOME/,
      keepInstall: true
    },
    {
      label: "ALAYA_BIN_DIR=/usr/local/bin",
      args: [],
      env: (work, home) => ({
        ALAYA_HOME: path.join(home, ".local", "share", "do-soul-alaya"),
        ALAYA_BIN_DIR: "/usr/local/bin",
        ALAYA_CONFIG_DIR: path.join(work, "config")
      }),
      refuse: /ALAYA_BIN_DIR points at a system path/,
      keepInstall: true
    }
  ];
  for (const tc of cases) {
    const work = mkdtempSync(path.join(tmpdir(), "alaya-uninstall-refuse-"));
    try {
      const home = path.join(work, "home");
      const sentinel = writeSentinel(home);
      const env = tc.env(work, home);
      if (tc.keepInstall) {
        mkdirSync(env.ALAYA_HOME, { recursive: true });
        writeFileSync(path.join(env.ALAYA_HOME, "marker"), "install-body");
      }
      const result = runUninstall(work, { HOME: home, ...env }, tc.args);
      assert.notEqual(result.status, 0, `${tc.label}\n${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, tc.refuse, tc.label);
      assert.equal(readFileSync(sentinel, "utf8"), "keep-me", tc.label);
      if (tc.keepInstall) {
        assert.equal(existsSync(path.join(env.ALAYA_HOME, "marker")), true, tc.label);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test("uninstall removes contained default paths and keeps HOME sentinels", () => {
  for (const purge of [false, true]) {
    const work = mkdtempSync(path.join(tmpdir(), "alaya-uninstall-valid-"));
    try {
      const home = path.join(work, "home");
      const installDir = path.join(home, ".local", "share", "do-soul-alaya");
      const bakDir = `${installDir}.bak`;
      const binDir = path.join(home, ".local", "bin");
      const configDir = path.join(home, ".config", "alaya");
      for (const dir of [installDir, bakDir, binDir, configDir]) mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(installDir, "marker"), "install-body");
      writeFileSync(path.join(bakDir, "old"), "rollback");
      writeFileSync(path.join(configDir, "alaya.db"), "durable");
      writeFileSync(path.join(binDir, "alaya"), "shim");
      const sentinel = writeSentinel(home);
      const result = runUninstall(work, {
        HOME: home, XDG_CONFIG_HOME: "", ALAYA_CONFIG_DIR: "",
        ALAYA_HOME: installDir, ALAYA_BIN_DIR: binDir
      }, purge ? ["--purge", "--remove-bak"] : ["--remove-bak"]);
      assert.equal(result.status, 0, `${purge}\n${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(installDir), false);
      assert.equal(existsSync(bakDir), false);
      assert.equal(existsSync(path.join(binDir, "alaya")), false);
      assert.equal(existsSync(path.join(configDir, "alaya.db")), !purge);
      assert.equal(readFileSync(sentinel, "utf8"), "keep-me");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test("uninstall unlinks a contained ALAYA_HOME symlink without deleting its target", () => {
  const work = mkdtempSync(path.join(tmpdir(), "alaya-uninstall-symlink-"));
  try {
    const home = path.join(work, "home");
    const target = path.join(work, "unrelated");
    const link = path.join(work, "alaya-home");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "payload"), "keep-target");
    symlinkSync(target, link);
    const sentinel = writeSentinel(home);
    const result = runUninstall(work, {
      HOME: home,
      ALAYA_HOME: link,
      ALAYA_BIN_DIR: path.join(work, "bin"),
      ALAYA_CONFIG_DIR: path.join(work, "config")
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(link), false);
    assert.equal(readFileSync(path.join(target, "payload"), "utf8"), "keep-target");
    assert.equal(readFileSync(sentinel, "utf8"), "keep-me");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("install.sh path admission is sourced without installer effects and still runs via stdin", () => {
  const work = mkdtempSync(path.join(tmpdir(), "alaya-install-share-"));
  try {
    const home = path.join(work, "home");
    const sentinel = writeSentinel(home);
    const sourced = spawnSync("bash", ["-c", `
      set -euo pipefail
      source "$1"
      command -v reject_unsafe_path >/dev/null
      command -v reject_recursive_delete_target >/dev/null
      test -z "\${REPO+x}"
      test -z "\${TMP_DIR+x}"
    `, "source-install", installScript], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home }
    });
    assert.equal(sourced.status, 0, sourced.stderr);

    const env = {
      ...process.env,
      HOME: home,
      ALAYA_HOME: home,
      ALAYA_BIN_DIR: path.join(work, "bin"),
      ALAYA_VERSION: "v0.3.11"
    };
    for (const result of [
      spawnSync("bash", [installScript], { cwd: work, encoding: "utf8", env }),
      spawnSync("bash", ["-s"], { cwd: work, encoding: "utf8", env, input: readFileSync(installScript) })
    ]) {
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(`${result.stdout}\n${result.stderr}`, /ALAYA_HOME cannot be \$HOME/);
      assert.equal(readFileSync(sentinel, "utf8"), "keep-me");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("uninstall purge follows XDG and explicit config overrides, preserving the other directory", () => {
  for (const explicit of [false, true]) {
    const work = mkdtempSync(path.join(tmpdir(), "alaya-uninstall-"));
    try {
      const home = path.join(work, "home");
      const defaultConfig = path.join(home, ".config", "alaya");
      const xdg = path.join(work, "xdg");
      const xdgConfig = path.join(xdg, "alaya");
      const override = path.join(work, "override");
      for (const dir of [defaultConfig, xdgConfig, override]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "alaya.db"), "fixture durable state");
      }
      const result = runUninstall(work, {
        HOME: home, XDG_CONFIG_HOME: xdg,
        ALAYA_CONFIG_DIR: explicit ? override : "", ALAYA_HOME: path.join(work, "install"),
        ALAYA_BIN_DIR: path.join(work, "bin")
      }, ["--purge"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(defaultConfig), true);
      assert.equal(existsSync(explicit ? override : xdgConfig), false);
      assert.equal(existsSync(explicit ? xdgConfig : override), true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});

test("installer pnpm admission matches the declared version boundaries", () => {
  const source = readFileSync(installScript, "utf8");
  const declaration = source.match(/pnpm_version_supported\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(declaration);
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.engines.pnpm, ">=12.3.4 <13");
  for (const [version, accepted] of [["12.0.0", false], ["12.3.3", false], ["12.3.4", true], ["12.4.0", true], ["13.0.0", false], ["12.3.4-beta.1", false]]) {
    const result = spawnSync("bash", ["-c", `${declaration}\npnpm_version_supported "$1"`, "version-check", version]);
    assert.equal(result.status === 0, accepted, version);
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
