import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const checker = fileURLToPath(new URL("./check-content-contracts.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("Git storage policy permits maintained definitions and rejects force-added generated history", () => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-tracked-bench-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(path.join(root, ".gitignore"), readFileSync(path.join(repoRoot, ".gitignore")));
    const maintained = ["README.md", "datasets/README.md", "datasets/.gitkeep", "datasets/locomo10.meta.json",
      "datasets/longmemeval_oracle.meta.json", "datasets/longmemeval_s.meta.json", "datasets/longmemeval_s.stratified-100.v1.json"];
    for (const file of maintained) {
      const target = path.join(root, "docs/bench-history", file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "fixture\n");
    }
    execFileSync("git", ["add", ".gitignore", "docs/bench-history"], { cwd: root });
    const nested = path.join(root, "apps", "consumer");
    mkdirSync(nested, { recursive: true });
    const check = cwd => spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
    for (const cwd of [root, nested]) {
      const clean = check(cwd);
      assert.equal(clean.status, 0, clean.stderr);
    }
    for (const relative of ["docs/bench-history/public/run/kpi.json", "docs/bench-history/datasets/longmemeval-extraction-cache/ab/key.json", ".bench-artifacts/history/public/run/kpi.json"]) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "{}\n");
      execFileSync("git", ["add", "--force", relative], { cwd: root });
      for (const cwd of [root, nested]) {
        const rejected = check(cwd);
        assert.notEqual(rejected.status, 0);
        assert.ok(rejected.stderr.includes(`${relative}: generated benchmark artifacts must remain untracked`));
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit local history checks retain pointer, passing, and compact-diagnostic failures", () => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-local-history-"));
  try {
    const bench = path.join(root, "public"), archive = path.join(bench, "run");
    mkdirSync(archive, { recursive: true });
    const pointer = path.join(bench, "latest-passing.json");
    const writePointer = value => writeFileSync(pointer, JSON.stringify(value));
    const complete = { sample_size: 500, evaluated_count: 500, kpi: { seed_extraction_path: {
      path: "official_api_compile", offline_fallbacks: 0, live_extraction_failures: 0, cached_extraction_failures: 0
    }, recall_token_economy: {} } };
    writeFileSync(path.join(archive, "kpi.json"), JSON.stringify(complete));
    writePointer({ slug: "run", kpi_path: "run/kpi.json" });
    const check = () => spawnSync(process.execPath, [checker, "--history-root", root], { encoding: "utf8" });
    assert.equal(check().status, 0);
    const relative = spawnSync(process.execPath, [checker, "--history-root", "."], { cwd: root, encoding: "utf8" });
    assert.equal(relative.status, 0, relative.stderr);
    writeFileSync(path.join(archive, "findings.md"), "A preserved failing finding.\n");
    assert.match(check().stderr, /must not point to an archive with findings.md/);
    rmSync(pointer);
    writeFileSync(path.join(bench, "latest-run.json"), JSON.stringify({ slug: "run", kpi_path: "run/kpi.json" }));
    assert.equal(check().status, 0, "a failed latest-run remains valid history");
    assert.equal(readFileSync(path.join(archive, "findings.md"), "utf8"), "A preserved failing finding.\n");
    writePointer({ slug: "missing", kpi_path: "missing/kpi.json" });
    assert.match(check().stderr, /failed to read JSON/);
    writePointer({ slug: "../outside", kpi_path: "../outside/kpi.json" });
    assert.match(check().stderr, /safe relative paths/);
    rmSync(pointer);
    writeFileSync(path.join(archive, "longmemeval-diagnostics.json"), JSON.stringify({ questions: [{ id: "full-detail" }] }));
    assert.match(check().stderr, /archive diagnostics must be compact/);
    const missing = spawnSync(process.execPath, [checker, "--history-root", path.join(root, "missing")], { encoding: "utf8" });
    assert.notEqual(missing.status, 0, "an explicit absent input is an error");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
