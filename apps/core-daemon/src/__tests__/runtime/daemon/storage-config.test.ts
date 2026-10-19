import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseStorageDbPathFromToml, resolveConfiguredDatabasePath } from "../../../runtime/daemon/support/storage-config.js";
import { replaceStorageDbPathInToml } from "../../../runtime/config/storage-pointer-file.js";
import { resolveAlayaConfigDir, resolveAlayaConfigPaths } from "../../../cli/support/config-files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const locator = fileURLToPath(new URL("../../../../../../scripts/resolve-live-db-path.mjs", import.meta.url));

describe("configured database path shared with installer", () => {
  it.each([
    String.raw`C:\Users\new\alaya.db`,
    String.raw`\\nas\new\quoted"file.db`,
    "C:\\new\\trailing\\"
  ])("round-trips writer-escaped backslashes through daemon and locator: %s", async (dbPath) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "alaya-escaped-path-")));
    roots.push(root);
    const configDir = path.join(root, "config");
    await mkdir(configDir);
    const toml = replaceStorageDbPathInToml("", dbPath);
    expect(parseStorageDbPathFromToml(toml)).toBe(dbPath);
    await writeFile(path.join(configDir, "alaya.toml"), toml);
    const env = { ...process.env, ALAYA_CONFIG_DIR: configDir, DATA_DIR: "ignored" };
    const expected = path.resolve(root, dbPath);
    expect(await resolveConfiguredDatabasePath(resolveAlayaConfigPaths(configDir), {
      env, launchCwd: root, fallbackPath: path.join(configDir, "fallback.db")
    })).toBe(expected);
    const output = execFileSync(process.execPath, [locator], { cwd: root, env, encoding: "utf8" });
    expect(output.trim().split("\t")).toEqual([configDir, expected]);
  });

  it("decodes supported escapes once and preserves unsupported escapes", () => {
    const original = 'folder\\new/quoted"file\nnext.db';
    expect(parseStorageDbPathFromToml(`[storage]\ndb_path = ${JSON.stringify(original)}\n`)).toBe(original);
    expect(parseStorageDbPathFromToml(String.raw`[storage]
db_path = "folder\tname.db"`)).toBe(String.raw`folder\tname.db`);
    expect(parseStorageDbPathFromToml('[storage]\ndb_path = ""\n')).toBe("");
    for (const literal of ['"unterminated', "unquoted"]) {
      expect(parseStorageDbPathFromToml(`[storage]\ndb_path = ${literal}\n`)).toBeNull();
    }
  });

  it.each(["toml", "DATA_DIR"])("uses the same launch cwd for relative %s paths", async (kind) => {
    // Child processes resolve cwd physically, including symlinked temp directories.
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "alaya-config-path-")));
    roots.push(root);
    const configDir = path.join(root, "xdg", "alaya");
    const env = { ...process.env, ALAYA_CONFIG_DIR: "", XDG_CONFIG_HOME: path.join(root, "xdg"), APPDATA: path.join(root, "xdg"), DATA_DIR: "data" };
    await mkdir(configDir, { recursive: true });
    if (kind === "toml") await writeFile(path.join(configDir, "alaya.toml"), '[storage]\ndb_path = "data/custom.db"\n');
    expect(resolveAlayaConfigDir({ env })).toBe(configDir);
    for (const cwdName of ["launch-a", "launch-b"]) {
      const launchCwd = path.join(root, cwdName);
      await mkdir(path.join(launchCwd, "data"), { recursive: true });
      const expected = path.join(launchCwd, "data", kind === "toml" ? "custom.db" : "alaya.db");
      await writeFile(expected, cwdName);
      const daemonPath = await resolveConfiguredDatabasePath(resolveAlayaConfigPaths(configDir), {
        env, launchCwd, fallbackPath: path.join(configDir, "alaya.db")
      });
      const output = execFileSync(process.execPath, [locator], { cwd: launchCwd, env, encoding: "utf8" });
      const [locatedConfig, installerPath] = output.trim().split("\t");
      expect(locatedConfig).toBe(configDir);
      expect(daemonPath).toBe(expected);
      expect(installerPath).toBe(expected);
      expect(await readFile(installerPath!, "utf8")).toBe(cwdName);
    }
  });
});
