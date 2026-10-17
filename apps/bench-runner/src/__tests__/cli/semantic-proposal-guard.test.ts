import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const bench = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repository = resolve(bench, "../..");
const guard = new URL("../support/source-import-boundary.mjs", import.meta.url);
const strict = new URL("../support/strict-provider-free-cli-bootstrap.mjs", import.meta.url).href;
const roots: string[] = [];
const config = ["-c", "core.autocrlf=true", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "credential.helper=", "-c", "core.askPass="];
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, env: gitEnv, maxBuffer: 8 * 1024 * 1024 });
}
function fixture() {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "proposal-guard-")));
  roots.push(outer);
  const root = join(outer, "checkout"), app = join(root, "apps/bench-runner"), out = join(outer, "output");
  mkdirSync(app, { recursive: true }); mkdirSync(out);
  cpSync(join(bench, "dist"), join(app, "dist"), { recursive: true,
    filter: path => !path.endsWith(".d.ts") && !path.endsWith(".map") });
  cpSync(join(bench, "bin"), join(app, "bin"), { recursive: true });
  mkdirSync(join(app, "scripts/longmemeval-replay"), { recursive: true });
  cpSync(join(bench, "scripts/longmemeval-replay/measurement-status.mjs"), join(app, "scripts/longmemeval-replay/measurement-status.mjs"));
  symlinkSync(join(bench, "node_modules"), join(app, "node_modules"), "dir");
  writeFileSync(join(app, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, ".gitignore"), "apps/bench-runner/dist/\napps/bench-runner/node_modules\napps/bench-runner/bin/\n");
  writeFileSync(join(root, "source.txt"), "original\n");
  git(root, ["init", "--quiet"]); git(root, ["add", "."]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "authored fixture"]);
  const workset = join(out, "workset.json"), preflight = join(out, "preflight.json"), cache = join(out, "absent-cache");
  writeFileSync(workset, JSON.stringify({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: "step-3.5-flash-2603", request_profile: "step-3.5-2603-low-json-schema-v1",
    provider_url: "https://api.stepfun.com/v1",
    items: [{ original_query: "Which authored project did Rowan lead?",
      generation_presentation: "nested-referent-constraints-v1" }] }));
  return { root, outer, out, app, workset, preflight, cache };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, program?: string, optIn = true) {
  const preload = new URL(guard);
  if (optIn) preload.searchParams.set("authority_checkout", f.root);
  const argv = program === undefined
    ? [join(f.app, "bin/alaya-bench-runner.mjs"), "semantic-proposal-fill", "--kind", "query", "--action", "prepare",
      "--workset", f.workset, "--cache-root", f.cache, "--max-output-tokens", "4096", "--max-attempts-per-key", "1", "--preflight-out", f.preflight]
    : ["--input-type=module", "--eval", program];
  return spawnSync(process.execPath, ["--permission", "--allow-child-process", `--allow-fs-read=${repository}`,
    `--allow-fs-read=${f.outer}`, "--allow-fs-read=/usr/bin/git", `--allow-fs-write=${f.out}`,
    "--import", preload.href, "--import", strict, ...argv], {
    cwd: f.root, env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
    encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  });
}
function receipt(stderr: string) {
  const line = stderr.split("\n").find(line => line.startsWith("[source-import-guard-receipt] "));
  expect(line, stderr).toBeDefined();
  return JSON.parse(line!.slice("[source-import-guard-receipt] ".length));
}
function oracle(root: string) {
  const head = git(root, ["rev-parse", "HEAD"]).toString().trim();
  const hash = createHash("sha256").update("git-worktree-v1\0").update(head).update("\0")
    .update(git(root, [...config, "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]));
  const paths = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  for (const path of paths) hash.update(`\0${path}\0${lstatSync(join(root, path)).mode & 0o777}\0${git(root,
    ["hash-object", "--no-filters", "--", path]).toString().trim()}`);
  return `git-worktree-v1:${head}:${hash.digest("hex")}`;
}

it("runs compiled prepare under the opted-in guard with genuine dirty revisions and no provider, native, worker or cache effects", () => {
  const f = fixture();
  const revisions = [];
  for (const state of ["clean", "tracked", "untracked", "bytes", "mode", "deletion"]) {
    if (state === "tracked") writeFileSync(join(f.root, "source.txt"), "changed source\n");
    if (state === "untracked") writeFileSync(join(f.root, "new source.txt"), "raw\r\n");
    if (state === "bytes") writeFileSync(join(f.root, "new source.txt"), "different raw\r\n");
    if (state === "mode") chmodSync(join(f.root, "new source.txt"), 0o755);
    if (state === "deletion") rmSync(join(f.root, "source.txt"));
    const current = { ...f, preflight: join(f.out, `${state}.json`) };
    const expected = oracle(f.root), result = run(current);
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const preflight = JSON.parse(readFileSync(current.preflight, "utf8"));
    expect(preflight).toMatchObject({ provider_calls: 0, missing: 1, maximum_attempts_per_key: 1,
      execution_scope: { implementation_revision: expected, execution_root_binding: null } });
    expect(existsSync(f.cache)).toBe(false);
    const evidence = receipt(result.stderr);
    expect(evidence.credential_file_violations).toEqual([]);
    expect(evidence.operations.map((row: { operation: string }) => row.operation))
      .toEqual(Array(state === "clean" || state === "tracked" ? 3 : 4).fill("process.execFileSync.authority-git.allowed"));
    expect(evidence.operations.every((row: { cwd: string; credential_environment_count: number; inherited_git_config: boolean }) =>
      row.cwd === f.root && row.credential_environment_count === 0 && !row.inherited_git_config)).toBe(true);
    revisions.push(preflight.execution_scope.implementation_revision);
    console.info("PREPARE_GUARD_RECEIPT", JSON.stringify({ state, revision: expected, provider_calls: preflight.provider_calls,
      cache_exists: existsSync(f.cache), credential_file_violations: evidence.credential_file_violations,
      operations: evidence.operations.map(({ stack: _stack, ...row }: { stack: string }) => row) }));
  }
  expect(new Set(revisions).size).toBe(6);
}, 60_000);

it("prepares from a bound linked worktree without substituting its common checkout revision", () => {
  const f = fixture(), linked = join(f.outer, "linked");
  git(f.root, ["worktree", "add", "--quiet", "--detach", linked]);
  cpSync(f.app, join(linked, "apps/bench-runner"), { recursive: true });
  writeFileSync(join(linked, "source.txt"), "linked checkout dirty bytes\n");
  writeFileSync(join(linked, "linked-only.txt"), "untracked linked source\n");
  const result = run({ ...f, root: linked, app: join(linked, "apps/bench-runner") });
  expect(result.status, result.stderr).toBe(0);
  const preflight = JSON.parse(readFileSync(f.preflight, "utf8"));
  expect(preflight.execution_scope.implementation_revision).toBe(oracle(linked));
  expect(preflight.execution_scope.implementation_revision).not.toBe(oracle(f.root));
  expect(receipt(result.stderr).operations).toHaveLength(4);
});

it("retains default refusal without the explicit checkout opt-in", () => {
  const f = fixture(), result = run(f, undefined, false);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("process.execFileSync");
  expect(existsSync(f.preflight)).toBe(false); expect(existsSync(f.cache)).toBe(false);
});

const valid = { cwd: "ROOT", env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
it.each([
  ["command", "sh", [...config, "rev-parse", "HEAD", "--show-toplevel"], {}],
  ["write", "git", [...config, "hash-object", "-w", "--no-filters", "--", "source.txt"], {}],
  ["arbitrary operation", "git", [...config, "status"], {}],
  ["extra argument", "git", [...config, "rev-parse", "HEAD", "--show-toplevel", "--git-dir"], {}],
  ["shell", "git", [...config, "rev-parse", "HEAD", "--show-toplevel"], { shell: true }],
  ["cwd", "git", [...config, "rev-parse", "HEAD", "--show-toplevel"], { cwd: "/" }],
  ["credential environment", "git", [...config, "rev-parse", "HEAD", "--show-toplevel"], { env: { ...gitEnv, FIXTURE_SECRET: "blocked" } }],
  ["loader environment", "git", [...config, "rev-parse", "HEAD", "--show-toplevel"], { env: { ...gitEnv, LD_PRELOAD: "/forbidden" } }],
  ["executable search override", "git", [...config, "rev-parse", "HEAD", "--show-toplevel"], { env: { ...gitEnv, PATH: "/forbidden" } }],
  ["stdin", "git", [...config, "rev-parse", "HEAD", "--show-toplevel"], { input: "forbidden" }],
  ["config environment", "git", [...config, "rev-parse", "HEAD", "--show-toplevel"], { env: { ...gitEnv, GIT_CONFIG_COUNT: "1" } }],
  ["changed required environment", "git", [...config, "rev-parse", "HEAD", "--show-toplevel"], { env: { ...gitEnv, GIT_OPTIONAL_LOCKS: "1" } }],
  ["path escape", "git", [...config, "hash-object", "--no-filters", "--", "../outside.txt"], {}],
  ["absolute path", "git", [...config, "hash-object", "--no-filters", "--", "/etc/passwd"], {}],
  ["unlisted path", "git", [...config, "hash-object", "--no-filters", "--", "source.txt"], {}],
  ["textconv enabled", "git", [...config, "--no-pager", "diff", "--no-ext-diff", "--binary", "HEAD", "--"], {}]
])("refuses authority Git %s before execution", (_name, command, args, changes) => {
  const f = fixture(), options = { ...valid, cwd: f.root, ...changes };
  const result = run(f, `import { execFileSync } from "node:child_process";
    execFileSync(${JSON.stringify(command)}, ${JSON.stringify(args)}, ${JSON.stringify(options)});`);
  expect(result.status).not.toBe(0);
  const evidence = receipt(result.stderr);
  expect(evidence.operations).toHaveLength(1);
  expect(evidence.operations[0]).toMatchObject({ operation: "process.execFileSync.authority-context", blocked: true });
});

it.each([
  ["textconv", ["diff.fixture.textconv", "forbidden-helper"]],
  ["external diff", ["diff.external", "forbidden-helper"]],
  ["filter", ["filter.fixture.clean", "forbidden-helper"]],
  ["fsmonitor", ["core.fsmonitor", "forbidden-helper"]],
  ["include", ["include.path", "/forbidden"]],
  ["alternate worktree", ["core.worktree", "/forbidden"]],
  ["external attributes", ["core.attributesFile", "/forbidden"]],
  ["external excludes", ["core.excludesFile", "/forbidden"]],
  ["promisor", ["remote.origin.promisor", "true"]]
])("refuses unsupported %s configuration without executing Git or helpers", (_name, entry) => {
  const f = fixture(); git(f.root, ["config", ...entry]);
  const result = run(f);
  expect(result.status).not.toBe(0);
  expect(receipt(result.stderr).operations).toEqual([expect.objectContaining({ blocked: true })]);
  expect(existsSync(f.preflight)).toBe(false);
});

it.each(["symlink", "credential", "submodule", "alternate objects", "promisor objects"])("fails closed for unsupported %s paths", kind => {
  const f = fixture();
  if (kind === "symlink") symlinkSync("../output/workset.json", join(f.root, "escaping-link"));
  if (kind === "credential") writeFileSync(join(f.root, ".env"), "authored-not-a-credential");
  if (kind === "submodule") git(f.root, ["update-index", "--add", "--cacheinfo", `160000,${git(f.root, ["rev-parse", "HEAD"]).toString().trim()},nested`]);
  if (kind === "alternate objects") writeFileSync(join(f.root, ".git/objects/info/alternates"), "/forbidden\n");
  if (kind === "promisor objects") writeFileSync(join(f.root, ".git/objects/pack/fixture.promisor"), "");
  const result = run(f);
  expect(result.status).not.toBe(0);
  expect(receipt(result.stderr).operations.some((row: { blocked?: boolean }) => row.blocked)).toBe(true);
  expect(existsSync(f.preflight)).toBe(false); expect(existsSync(f.cache)).toBe(false);
});
