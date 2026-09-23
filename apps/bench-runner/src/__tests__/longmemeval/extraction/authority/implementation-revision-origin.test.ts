import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const benchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const processFixture = join(dirname(fileURLToPath(import.meta.url)), "implementation-origin-process.mjs");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "bench-implementation-origin-"));
  roots.push(root);
  const bench = join(root, "apps/bench-runner");
  mkdirSync(bench, { recursive: true });
  cpSync(join(benchRoot, "dist"), join(bench, "dist"), { recursive: true });
  symlinkSync(join(benchRoot, "node_modules"), join(bench, "node_modules"), "dir");
  writeFileSync(join(bench, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, ".gitignore"), "apps/bench-runner/dist/\napps/bench-runner/node_modules\n");
  writeFileSync(join(root, "source.txt"), "original\n");
  git(root, ["init", "--quiet"]);
  git(root, ["add", ".gitignore", "source.txt", "apps/bench-runner/package.json"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "fixture"]);
  return root;
}

function git(root: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
}

function inspect(loadedRoot: string, callerCwd: string) {
  const modulePath = join(loadedRoot, "apps/bench-runner/dist/runs/extraction/authority/inspection.js");
  const scopePath = join(loadedRoot, "apps/bench-runner/dist/runs/semantic-proposal/authority.js");
  return JSON.parse(execFileSync(process.execPath, [processFixture], { cwd: callerCwd, encoding: "utf8",
    env: { ...process.env, IMPLEMENTATION_MODULE: modulePath, PROPOSAL_AUTHORITY_MODULE: scopePath,
      PROPOSAL_OUTPUT_ROOT: join(loadedRoot, "absent-query-cache") } })) as {
    revision: string; scopeRevision: string; outputRootAbsent: boolean; sourceWrongRejected: boolean;
  };
}

it("binds native source and query revisions to the loaded checkout across caller directories", () => {
  const loaded = checkout(), foreign = checkout(), nonGit = mkdtempSync(join(tmpdir(), "bench-nongit-caller-"));
  roots.push(nonGit);
  writeFileSync(join(foreign, "source.txt"), "different foreign commit\n");
  git(foreign, ["add", "source.txt"]);
  git(foreign, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "foreign"]);

  const baseline = inspect(loaded, loaded);
  for (const caller of [join(loaded, "apps"), foreign, nonGit]) {
    expect(inspect(loaded, caller)).toEqual(baseline);
  }
  expect(baseline.revision.startsWith(`git-worktree-v1:${git(loaded, ["rev-parse", "HEAD"]).toString().trim()}:`))
    .toBe(true);
  expect(baseline.scopeRevision).toBe(baseline.revision);
  expect(baseline.outputRootAbsent).toBe(true);
  expect(baseline.sourceWrongRejected).toBe(true);
  expect(inspect(foreign, loaded).revision).not.toBe(baseline.revision);
});

it("binds large tracked patches and untracked bytes and modes to the loaded checkout", () => {
  const loaded = checkout(), foreign = checkout();
  const baseline = inspect(loaded, foreign).revision;
  writeFileSync(join(loaded, "source.txt"), "changed UTF-8 内容\n".repeat(90_000));
  expect(git(loaded, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]).byteLength)
    .toBeGreaterThan(1024 * 1024);
  const changedTracked = inspect(loaded, foreign).revision;
  expect(changedTracked).not.toBe(baseline);
  writeFileSync(join(loaded, "source.txt"), "changed UTF-8 内容\n".repeat(90_000) + "tail\n");
  const changedTail = inspect(loaded, foreign).revision;
  expect(changedTail).not.toBe(changedTracked);
  const untracked = join(loaded, "untracked source.txt");
  writeFileSync(untracked, "first bytes\n");
  const changedUntracked = inspect(loaded, foreign).revision;
  expect(changedUntracked).not.toBe(changedTail);
  writeFileSync(untracked, "new bytes\n");
  const changedBytes = inspect(loaded, foreign).revision;
  expect(changedBytes).not.toBe(changedUntracked);
  chmodSync(untracked, 0o755);
  expect(inspect(loaded, foreign).revision).not.toBe(changedBytes);
  writeFileSync(join(foreign, "source.txt"), "foreign-only drift\n");
  expect(inspect(loaded, foreign).revision).toBe(inspect(loaded, loaded).revision);
});

it("fails closed when the loaded module has no Git checkout, even from another Git cwd", () => {
  const loaded = checkout(), foreign = checkout();
  rmSync(join(loaded, ".git"), { recursive: true });
  const result = spawnSync(process.execPath, [processFixture], { cwd: foreign, encoding: "utf8", env: {
    ...process.env,
    IMPLEMENTATION_MODULE: join(loaded, "apps/bench-runner/dist/runs/extraction/authority/inspection.js"),
    PROPOSAL_AUTHORITY_MODULE: join(loaded, "apps/bench-runner/dist/runs/semantic-proposal/authority.js"),
    PROPOSAL_OUTPUT_ROOT: join(loaded, "absent-query-cache")
  } });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/cannot establish the loaded bench-runner Git checkout/u);
});
