import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("rejects direct and symlink output inside retained paid evidence before mkdir or child execution", () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-replay-containment-"));
  try {
    const repo = join(root, "repo");
    const paid = join(root, "paid");
    const cache = join(paid, "cache");
    const bin = join(root, "bin");
    for (const directory of [repo, cache, bin]) mkdirSync(directory, { recursive: true });
    for (const args of [["init", "--quiet"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--quiet", "--allow-empty", "-m", "fixture"]]) {
      assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
    }
    const source = join(root, "source.json");
    for (const path of [source, join(root, "source-map.json"), join(root, "preflight.json"),
      join(cache, "batch-state-plan.json")]) writeFileSync(path, "{}");
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ cacheRoot: cache, planIdentity: "plan", preparationDirectory: root,
      sourcePath: source, regressionPath: source, canonicalPath: source }));
    const pnpm = join(bin, "pnpm");
    writeFileSync(pnpm, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.SPAWN_PROBE,"spawned");\n');
    chmodSync(pnpm, 0o755);
    const alias = join(root, "paid-alias");
    symlinkSync(paid, alias, "dir");
    for (const output of [paid, join(alias, "new-derived-output")]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./replay-enrichment-admission.mjs", import.meta.url)),
        config, output], { cwd: repo, encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPAWN_PROBE: join(paid, "spawned") } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /outside the retained paid root/);
      assert.deepEqual(readdirSync(paid), ["cache"]);
      assert.deepEqual(readdirSync(cache), ["batch-state-plan.json"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
