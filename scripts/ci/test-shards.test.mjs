import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { partitionBenchFiles, filesDigest, createVitestEnv, VITEST_PROJECT_GROUPS } from "./vitest-projects.mjs";

test("coverage merge reuses the existing heap cap and honors explicit heap settings", () => {
  assert.equal(createVitestEnv(true, {}).NODE_OPTIONS, "--max-old-space-size=6144");
  assert.equal(createVitestEnv(false, {}).NODE_OPTIONS, "--max-old-space-size=3584");
  assert.equal(createVitestEnv(true, { NODE_OPTIONS: "--max-old-space-size=2048" }).NODE_OPTIONS, "--max-old-space-size=2048");
});

test("duration partition balances long files instead of file counts", () => {
  const weights = { a: 9, b: 8, c: 3, d: 2, e: 2 };
  assert.deepEqual(partitionBenchFiles(Object.keys(weights), 2, weights, 20), [["a", "d", "e"], ["b", "c"]]);
});

test("duration partition is stable across input ordering and includes unknown files once", () => {
  const files = ["d", "b", "new", "a", "c"];
  const weights = { a: 9, b: 8, c: 3, d: 2 };
  const expected = [["new"], ["a", "d"], ["b", "c"]];
  assert.deepEqual(partitionBenchFiles(files, 3, weights, 20), expected);
  assert.deepEqual(partitionBenchFiles([...files].reverse(), 3, weights, 20), expected);
  assert.deepEqual(partitionBenchFiles(files, 3, weights, 20).flat().sort(), files.sort());
});

test("duration partition rejects duplicate files and invalid weights or widths", () => {
  assert.throws(() => partitionBenchFiles(["a", "a"], 2, { a: 1 }, 20), /duplicate/);
  assert.throws(() => partitionBenchFiles(["a"], 0, { a: 1 }, 20), /count/);
  assert.throws(() => partitionBenchFiles(["a"], 2, { a: -1 }, 20), /weight/);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkShards } from "./check-shard-manifests.mjs";

const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
const commit = "a".repeat(40);
function manifests() {
  const root = mkdtempSync(path.join(tmpdir(), "ci-shards-"));
  temporary.push(root);
  for (const [group, projects] of Object.entries(VITEST_PROJECT_GROUPS)) {
    const count = group === "bench-runner" ? 2 : 1;
    for (let index = 1; index <= count; index++) {
      const dir = path.join(root, `${group}-${index}`);
      mkdirSync(dir);
      writeFileSync(path.join(dir, "shard-manifest.json"), JSON.stringify({
        label: "ubuntu-node24", group, projects, status: "success", commit,
        ...(count === 1 ? {} : {
          shard: `${index}/${count}`,
          partition: { algorithm: "duration-lpt", count: 2, digest: filesDigest(["a", "b"]), files: [index === 1 ? "a" : "b"] }
        })
      }));
    }
  }
  return root;
}
function mutateManifest(root, group, change) {
  const file = path.join(root, group, "shard-manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  change(manifest);
  writeFileSync(file, JSON.stringify(manifest));
}
function check(root) { return checkShards({ label: "ubuntu-node24", shardDir: root, needsResult: "success", commit }); }

test("complete duration partitions pass and missing partition evidence fails", () => {
  const root = manifests();
  assert.deepEqual(check(root), []);
  mutateManifest(root, "bench-runner-1", (m) => { delete m.partition; });
  assert.match(check(root).join("\n"), /partition/);
});

test("partition gate rejects duplicate or omitted files and differing universes", () => {
  for (const mutate of [
    (m) => { m.partition.files = ["b"]; },
    (m) => { m.partition.files = []; },
    (m) => { m.partition.digest = "0".repeat(64); }
  ]) {
    const root = manifests();
    mutateManifest(root, "bench-runner-1", mutate);
    assert.match(check(root).join("\n"), /partition/);
  }
});

test("manifest gate rejects wrong commits and unknown groups", () => {
  const root = manifests();
  mutateManifest(root, "bench-runner-1", (m) => { m.commit = "b".repeat(40); });
  assert.match(check(root).join("\n"), /commit/);
  mutateManifest(root, "bench-runner-1", (m) => { m.commit = commit; m.group = "unknown"; });
  assert.match(check(root).join("\n"), /unknown/);
});

import { copyFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PROJECT_COVERAGE, sanitizeProjectName } from "./vitest-projects.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
test("only root CI shard metadata is excluded from untracked source discovery", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-shard-ignore-"));
  temporary.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  copyFileSync(path.join(repo, ".gitignore"), path.join(root, ".gitignore"));
  git("add", ".gitignore");
  mkdirSync(path.join(root, "src"));
  const generated = ["shard-projects.json", "shard-manifest.json"];
  const sources = ["src/shard-projects.json", "src/shard-manifest.json", "source.json", "source.ts"];
  for (const name of [...generated, ...sources]) writeFileSync(path.join(root, name), "{}\n");
  assert.deepEqual(git("check-ignore", "--", ...generated, ...sources).trim().split("\n"), generated);
  assert.deepEqual(git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort(),
    sources.sort());
  // Ignore rules must not hide modifications to files already tracked by Git.
  git("add", "--force", "--", ...generated, ...sources);
  for (const name of [...generated, ...sources]) writeFileSync(path.join(root, name), "changed\n");
  assert.deepEqual(git("diff", "--name-only").trim().split("\n").sort(), [...generated, ...sources].sort());
});

function workflowJob(name) {
  const workflow = readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8");
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `workflow job ${name} is missing`);
  return workflow.slice(start + 1).split(/\n(?=  [a-z][a-z-]*:)/u)[0];
}

test("shared test checkout does not persist authentication rejected by authority inspection", () => {
  const job = workflowJob("test-shard-ubuntu");
  const checkout = job.split("      - uses: actions/checkout@v7\n")[1].split("\n      - uses:")[0];
  assert.match(checkout, /^          persist-credentials: false$/mu);
  for (const os of ["macos", "windows"]) assert.match(workflowJob(`test-shard-${os}`), /steps: \*shard-steps/u);
});

test("CI builds compiled daemon dependencies before whole-workspace typechecking on every OS", () => {
  const job = workflowJob("test-shard-ubuntu");
  const build = job.indexOf("      - name: Build\n        run: pnpm build");
  const typecheck = job.indexOf("      - name: Typecheck\n");
  assert.ok(build >= 0 && typecheck > build, "daemon dist must exist before bench-runner typecheck");
  assert.match(job.slice(typecheck), /if: \$\{\{ matrix.group == 'libraries' \}\}\n        run: pnpm run --if-present typecheck/u);
  for (const os of ["macos", "windows"]) assert.match(workflowJob(`test-shard-${os}`), /steps: \*shard-steps/u);
});

test("CI enables compile caching only outside coverage even with an inherited disable sentinel", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-compile-cache-"));
  temporary.push(root);
  const step = workflowJob("test-shard-ubuntu").split("      - name: Test\n")[1]
    .split("\n      - name:")[0];
  const run = step.split("        run: |\n")[1].replaceAll("${{ matrix.group }}", "bench-runner");
  assert.ok(run);
  assert.ok(step.includes("NODE_COMPILE_CACHE: ${{ env.SHARD_COVERAGE == '0' && matrix.group == 'bench-runner'"));
  mkdirSync(path.join(root, "scripts/ci"), { recursive: true });
  const probe = `import { getCompileCacheDir } from 'node:module';
    console.log(JSON.stringify({ enabled: getCompileCacheDir() !== undefined,
      disabled: Object.hasOwn(process.env, 'NODE_DISABLE_COMPILE_CACHE') }));`;
  writeFileSync(path.join(root, "scripts/ci/run-vitest-projects.mjs"), `
    import { spawnSync } from 'node:child_process';
    import { createVitestEnv } from ${JSON.stringify(new URL("./vitest-projects.mjs", import.meta.url).href)};
    const coverage = process.argv.includes('--coverage.enabled');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(probe)}],
      { encoding: 'utf8', env: createVitestEnv(coverage) });
    if (child.status !== 0) throw new Error(child.stderr);
    console.log(JSON.stringify({ ...JSON.parse(child.stdout), coverage }));
  `);
  for (const coverage of ["0", "1"]) {
    for (const sentinel of ["", "1"]) {
      const env = { ...process.env, SHARD_COVERAGE: coverage, VITEST_SHARD: "",
        NODE_COMPILE_CACHE: path.join(root, "cache"), NODE_DISABLE_COMPILE_CACHE: sentinel };
      const baseline = spawnSync(process.execPath, ["--input-type=module", "-e", probe],
        { encoding: "utf8", env });
      expectSuccess(baseline);
      assert.deepEqual(JSON.parse(baseline.stdout), { enabled: false, disabled: true });
      const result = spawnSync("bash", ["-e", "-c", run], { cwd: root, encoding: "utf8", env });
      expectSuccess(result);
      assert.deepEqual(JSON.parse(result.stdout), {
        enabled: coverage === "0", disabled: coverage === "1", coverage: coverage === "1"
      }, `coverage=${coverage}, inherited disable=${JSON.stringify(sentinel)}`);
    }
  }
  assert.doesNotMatch(step, /^          NODE_DISABLE_COMPILE_CACHE:/mu);
});

test("rerun uploads replace only their shard artifacts while retained successes keep stable names", () => {
  const job = workflowJob("test-shard-ubuntu");
  const uploads = job.split(/\n      - /u).filter((step) => step.includes("uses: actions/upload-artifact@v7"));
  assert.equal(uploads.length, 2);
  for (const [index, prefix] of ["shard", "coverage"].entries()) {
    const upload = uploads[index];
    assert.match(upload, /^          overwrite: true$/mu);
    assert.ok(upload.includes(`name: ${prefix}-\${{ env.SHARD_LABEL }}-\${{ matrix.group }}`));
    assert.ok(upload.includes("matrix.shard_name"));
    assert.doesNotMatch(upload, /run_attempt|run_id/);
  }
  // Every OS shares the uploader, and partial reruns still download retained successful shards.
  for (const os of ["macos", "windows"]) {
    assert.match(workflowJob(`test-shard-${os}`), /steps: \*shard-steps/);
  }
  const quality = workflowJob("quality-ubuntu");
  for (const prefix of ["shard", "coverage"]) {
    assert.ok(quality.includes(`pattern: ${prefix}-\${{ env.SHARD_LABEL }}-*`));
  }
  assert.doesNotMatch(quality, /run_attempt/);
});

test("install smoke executes independently but its existing gate requires every quality result", () => {
  const execution = workflowJob("install-smoke-check");
  assert.doesNotMatch(execution, /\n    needs:/);
  assert.match(execution, /^        run: node scripts\/ci\/smoke-built-cli\.mjs$/mu);
  const gate = workflowJob("install-smoke");
  assert.match(gate, /name: CLI install surface smoke\n/);
  assert.match(gate, /needs: \[quality-ubuntu, quality-macos, quality-windows, install-smoke-check\]/);
  assert.match(gate, /if: always\(\)/);
  const results = {
    QUALITY_UBUNTU_RESULT: "quality-ubuntu", QUALITY_MACOS_RESULT: "quality-macos",
    QUALITY_WINDOWS_RESULT: "quality-windows", INSTALL_SMOKE_RESULT: "install-smoke-check"
  };
  for (const [variable, job] of Object.entries(results)) {
    assert.ok(gate.includes(`${variable}: \${{ needs.${job}.result }}`));
  }
  const run = gate.split("        run: |\n")[1];
  assert.ok(run);
  const success = Object.fromEntries(Object.keys(results).map((key) => [key, "success"]));
  const execute = (env) => spawnSync("bash", ["-e", "-c", run], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(execute(success).status, 0);
  for (const key of Object.keys(results)) {
    for (const result of ["failure", "cancelled", "skipped", "unknown", ""]) {
      assert.equal(execute({ ...success, [key]: result }).status, 1, `${key}=${result} must fail closed`);
    }
  }
});

function command(cwd, script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" } });
}
function expectSuccess(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); }

function coverageFixture() {
  const parent = path.join(repo, ".cache/ci-shards");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "coverage-test-"));
  temporary.push(root);
  const testsDir = path.join(root, "apps/bench-runner/src/__tests__");
  mkdirSync(testsDir, { recursive: true });
  mkdirSync(path.join(root, "scripts/ci"), { recursive: true });
  for (const name of ["bench-sequencer.mjs", "bench-test-durations.json", "vitest-projects.mjs"]) {
    copyFileSync(path.join(repo, "scripts/ci", name), path.join(root, "scripts/ci", name));
  }
  writeFileSync(path.join(root, "apps/bench-runner/src/value.ts"), "const yes = 1;\nconst no = -1;\nexport function value(positive: boolean) { return positive ? yes : no; }\n");
  writeFileSync(path.join(root, "apps/bench-runner/src/unused.ts"), "export const unused = 0;\n");
  for (const [name, value, expected] of [["positive", true, 1], ["negative", false, -1]]) {
    writeFileSync(path.join(testsDir, `${name}.test.ts`), `import { test, expect } from 'vitest'; import { value } from '../value'; test('${name}', () => expect(value(${value})).toBe(${expected}));\n`);
  }
  writeFileSync(path.join(root, "vitest.config.mjs"), `import BenchSequencer from './scripts/ci/bench-sequencer.mjs'; export default { test: {
    projects: [{ test: { name: '@do-soul/alaya-bench-runner', include: ['apps/bench-runner/src/__tests__/*.test.ts'] } }],
    sequence: { sequencer: BenchSequencer }, maxWorkers: 1, coverage: { provider: 'v8', exclude: ['**/__tests__/**'] }
  } };\n`);
  const shardDir = path.join(root, "manifests");
  const coverageDir = path.join(root, "artifacts");
  return { root, testsDir, shardDir, coverageDir };
}

test("native blob coverage merges complementary branches and rejects invalid artifacts", { timeout: 120_000 }, () => {
  const { root, testsDir, shardDir, coverageDir } = coverageFixture();
  writeFileSync(path.join(root, "projects.json"), JSON.stringify({ projects: ["@do-soul/alaya-bench-runner"] }));
  const incomplete = command(root, path.join(repo, "scripts/ci/write-shard-manifest.mjs"), [
    "--group=bench-runner", "--label=ubuntu-node24", "--status=success", "--shard=1/2",
    "--projects-file=projects.json", "--output=incomplete.json"
  ]);
  assert.notEqual(incomplete.status, 0);
  assert.equal(JSON.parse(readFileSync(path.join(root, "incomplete.json"), "utf8")).status, "incomplete");
  for (let index = 1; index <= 2; index++) {
    expectSuccess(command(root, path.join(repo, "scripts/ci/run-vitest-projects.mjs"), [
      "--group=bench-runner", `--shard=${index}/2`, "--projects-file=projects.json", "--defer-coverage-thresholds",
      "--coverage.enabled", "--coverage.reporter=json-summary"
    ]));
    const dir = path.join(shardDir, `bench-runner-${index}`);
    mkdirSync(dir, { recursive: true });
    expectSuccess(command(root, path.join(repo, "scripts/ci/write-shard-manifest.mjs"), [
      "--group=bench-runner", "--label=ubuntu-node24", "--status=success", `--shard=${index}/2`, "--projects-file=projects.json",
      `--output=${path.join(dir, "shard-manifest.json")}`
    ]));
    const artifact = path.join(coverageDir, `coverage-ubuntu-node24-bench-runner-${index}-of-2`);
    mkdirSync(artifact, { recursive: true });
    copyFileSync(path.join(root, `coverage/bench-${index}-of-2.json`), path.join(artifact, `bench-${index}-of-2.json`));
    const partial = JSON.parse(readFileSync(path.join(root, `.cache/ci-shards/bench-${index}-of-2-coverage/coverage-summary.json`), "utf8"));
    assert.equal(partial.total.branches.pct, 50);
  }
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  for (const [group, projects] of Object.entries(VITEST_PROJECT_GROUPS)) {
    if (group === "bench-runner") continue;
    const dir = path.join(shardDir, group);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "shard-manifest.json"), JSON.stringify({ label: "ubuntu-node24", group, projects, status: "success", commit: currentCommit }));
    for (const project of projects) {
      const destination = path.join(coverageDir, `coverage-ubuntu-node24-${group}`, sanitizeProjectName(project));
      mkdirSync(destination, { recursive: true });
      writeFileSync(path.join(destination, "coverage-summary.json"), JSON.stringify({ total: Object.fromEntries(
        ["statements", "lines", "functions", "branches"].map((metric) => [metric, { pct: PROJECT_COVERAGE[project][metric] }])
      ) }));
    }
  }
  const verify = () => command(root, path.join(repo, "scripts/ci/check-shard-manifests.mjs"), [
    "--label=ubuntu-node24", `--shards=${shardDir}`, `--coverage=${coverageDir}`, "--needs-result=success"
  ]);
  expectSuccess(verify());
  const summary = JSON.parse(readFileSync(path.join(coverageDir, "merged/do-soul-alaya-bench-runner/coverage-summary.json"), "utf8"));
  assert.equal(summary.total.branches.pct, 100);
  assert.equal(summary[path.join(root, "apps/bench-runner/src/unused.ts").replaceAll("\\", "/")].statements.pct, 0);
  expectSuccess(command(root, path.join(repo, "scripts/ci/run-vitest-projects.mjs"), [
    "--group=bench-runner", "--coverage.enabled", "--coverage.reporter=json-summary"
  ]));
  const unsharded = JSON.parse(readFileSync(path.join(root, "coverage/do-soul-alaya-bench-runner/coverage-summary.json"), "utf8"));
  assert.deepEqual(summary, unsharded);
  const artifact = path.join(coverageDir, "coverage-ubuntu-node24-bench-runner-1-of-2/bench-1-of-2.json");
  const original = readFileSync(artifact, "utf8");
  rmSync(artifact);
  assert.match(verify().stderr, /coverage artifact missing/);
  writeFileSync(artifact, `${original}\n`);
  assert.match(verify().stderr, /blob digest differs/);
  const encoded = JSON.parse(original);
  encoded[Number(encoded[0][3])] = null;
  writeFileSync(artifact, JSON.stringify(encoded));
  mutateManifest(shardDir, "bench-runner-1", (m) => {
    m.coverage.sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  });
  assert.match(verify().stderr, /blob is incomplete/);
  encoded[0][3] = "9999999";
  writeFileSync(artifact, JSON.stringify(encoded));
  mutateManifest(shardDir, "bench-runner-1", (m) => {
    m.coverage.sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  });
  assert.match(verify().stderr, /blob is incomplete/);
  const alteredTests = JSON.parse(original);
  const test = alteredTests[Number(alteredTests[Number(alteredTests[0][1])][0])];
  alteredTests[Number(test.filepath)] = path.join(testsDir, "unexpected.test.ts");
  writeFileSync(artifact, JSON.stringify(alteredTests));
  mutateManifest(shardDir, "bench-runner-1", (m) => {
    m.coverage.sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  });
  assert.match(verify().stderr, /tests differ from partition/);
  writeFileSync(artifact, original);
  mutateManifest(shardDir, "bench-runner-1", (m) => {
    m.coverage.sha256 = createHash("sha256").update(original).digest("hex");
  });
  mkdirSync(path.join(coverageDir, "unknown-artifact"));
  assert.match(verify().stderr, /unexpected coverage artifact/);
  rmSync(path.join(coverageDir, "unknown-artifact"), { recursive: true });
  const originals = [];
  for (let index = 1; index <= 2; index++) {
    const blob = path.join(coverageDir, `coverage-ubuntu-node24-bench-runner-${index}-of-2/bench-${index}-of-2.json`);
    const originalBlob = readFileSync(blob, "utf8");
    originals.push([blob, originalBlob]);
    const encoded = JSON.parse(originalBlob);
    for (const reference of Object.values(encoded[Number(encoded[0][3])])) {
      const fileCoverage = encoded[Number(reference)];
      const statements = encoded[Number(fileCoverage.s)];
      for (const statement of Object.keys(statements)) statements[statement] = 0;
    }
    writeFileSync(blob, JSON.stringify(encoded));
    mutateManifest(shardDir, `bench-runner-${index}`, (m) => {
      m.coverage.sha256 = createHash("sha256").update(readFileSync(blob)).digest("hex");
    });
  }
  assert.match(verify().stderr, /native coverage merge failed/);
  for (const [offset, [blob, content]] of originals.entries()) {
    writeFileSync(blob, content);
    mutateManifest(shardDir, `bench-runner-${offset + 1}`, (m) => {
      m.coverage.sha256 = createHash("sha256").update(content).digest("hex");
    });
  }
  const summaryFile = path.join(coverageDir, "coverage-ubuntu-node24-libraries/do-soul-alaya-protocol/coverage-summary.json");
  writeFileSync(summaryFile, JSON.stringify({ total: { statements: { pct: 0 } } }));
  const below = verify();
  assert.notEqual(below.status, 0);
  assert.match(below.stderr, /below 88/);
});
