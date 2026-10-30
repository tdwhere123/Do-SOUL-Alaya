import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const bench = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repository = resolve(bench, "../..");
const guard = new URL("../support/source-import-boundary.mjs", import.meta.url);
const strict = new URL("../support/strict-provider-free-cli-bootstrap.mjs", import.meta.url).href;
const { createReadOnlyGitExecutionPolicy } = await import(/* @vite-ignore */
  new URL("../support/read-only-git-boundary.mjs", import.meta.url).href);
const gitExecutable: string = createReadOnlyGitExecutionPolicy().prepare("git").executable;
const roots: string[] = [];
const config = ["-c", "core.autocrlf=true", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "credential.helper=", "-c", "core.askPass="];
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, env: gitEnv, maxBuffer: 8 * 1024 * 1024 });
}
function fixture(templateEol?: "crlf") {
  // Git expands Windows short-name temp paths in worktree metadata. Bind the
  // same physical spelling before granting this fixture's filesystem access.
  const outer = realpathSync.native(mkdtempSync(join(tmpdir(), "proposal-guard-")));
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
  cpSync(join(repository, ".env.example"), join(root, ".env.example"));
  if (templateEol === "crlf") writeFileSync(join(root, ".env.example"),
    readFileSync(join(root, ".env.example"), "utf8").replace(/\r?\n/gu, "\r\n"));
  git(root, ["init", "--quiet"]);
  // The copied public template can be CRLF on Windows; retain its canonical
  // Git blob instead of depending on ambient config (which this fixture omits).
  git(root, ["config", "core.autocrlf", "true"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "authored fixture"]);
  const workset = join(out, "workset.json"), preflight = join(out, "preflight.json"), cache = join(out, "absent-cache");
  writeFileSync(workset, JSON.stringify({ input: "authored path-containment fixture" }));
  return { root, outer, out, app, workset, preflight, cache };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, program?: string, optIn = true, readRoots: readonly string[] = []) {
  const preload = new URL(guard);
  if (optIn) preload.searchParams.set("authority_checkout", f.root);
  const argv = ["--input-type=module", "--eval", program ?? revisionProgram(f.app)];
  return spawnSync(process.execPath, ["--permission", "--allow-child-process", `--allow-fs-read=${repository}`,
    `--allow-fs-read=${f.outer}`, ...readRoots.map(root => `--allow-fs-read=${root}`),
    `--allow-fs-read=${gitExecutable}`, `--allow-fs-write=${f.out}`,
    "--import", preload.href, "--import", strict, ...argv], {
    // Discover through the physical executable directory, not an alias requiring directory read grants.
    cwd: f.root, env: { PATH: dirname(gitExecutable), LANG: "C", LC_ALL: "C" },
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

it("reads the compiled authority revision under the opted-in guard without provider, native, worker or cache effects", () => {
  const f = fixture();
  const revisions = [];
  // Windows chmod cannot represent the POSIX executable-bit transition.
  const states = ["clean", "tracked", "untracked", "bytes",
    ...(process.platform === "win32" ? [] : ["mode"]), "deletion"];
  for (const state of states) {
    if (state === "tracked") writeFileSync(join(f.root, "source.txt"), "changed source\n");
    if (state === "untracked") writeFileSync(join(f.root, "new source.txt"), "raw\r\n");
    if (state === "bytes") writeFileSync(join(f.root, "new source.txt"), "different raw\r\n");
    if (state === "mode") chmodSync(join(f.root, "new source.txt"), 0o755);
    if (state === "deletion") rmSync(join(f.root, "source.txt"));
    const current = { ...f, preflight: join(f.out, `${state}.json`) };
    const expected = oracle(f.root), result = run(current);
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const inspection = JSON.parse(result.stdout);
    expect(inspection.revision).toBe(expected);
    expect(existsSync(current.preflight)).toBe(false);
    expect(existsSync(f.cache)).toBe(false);
    const evidence = receipt(result.stderr);
    expect(evidence.credential_file_violations).toEqual([]);
    expect(evidence.operations.map((row: { operation: string }) => row.operation))
      .toEqual(Array(state === "clean" || state === "tracked" ? 3 : 4).fill("process.execFileSync.authority-git.allowed"));
    expect(evidence.operations.every((row: { cwd: string; credential_environment_count: number; inherited_git_config: boolean }) =>
      row.cwd === f.root && row.credential_environment_count === 0 && !row.inherited_git_config)).toBe(true);
    revisions.push(inspection.revision);
    console.info("AUTHORITY_GUARD_RECEIPT", JSON.stringify({ state, revision: expected,
      cache_exists: existsSync(f.cache), credential_file_violations: evidence.credential_file_violations,
      operations: evidence.operations.map(({ stack: _stack, ...row }: { stack: string }) => row) }));
  }
  expect(new Set(revisions).size).toBe(states.length);
}, 60_000);

it("reads a bound linked worktree without substituting its common checkout revision", () => {
  const f = fixture(), linked = join(f.outer, "linked");
  git(f.root, ["worktree", "add", "--quiet", "--detach", linked]);
  cpSync(f.app, join(linked, "apps/bench-runner"), { recursive: true });
  writeFileSync(join(linked, "source.txt"), "linked checkout dirty bytes\n");
  writeFileSync(join(linked, "linked-only.txt"), "untracked linked source\n");
  const result = run({ ...f, root: linked, app: join(linked, "apps/bench-runner") });
  expect(result.status, result.stderr).toBe(0);
  const inspection = JSON.parse(result.stdout);
  expect(inspection.revision).toBe(oracle(linked));
  expect(inspection.revision).not.toBe(oracle(f.root));
  expect(existsSync(f.preflight)).toBe(false);
  expect(receipt(result.stderr).operations).toHaveLength(4);
});

const revisionProgram = (app: string) => `
  const { readCurrentExtractionAuthorityRevision } = await import(${JSON.stringify(
    pathToFileURL(join(app, "dist/runs/extraction/authority/inspection.js")).href)});
  console.log(JSON.stringify({ revision: readCurrentExtractionAuthorityRevision() }));`;

it("retains the pinned public-template blob for a CRLF fixture checkout", () => {
  const f = fixture("crlf");
  expect(git(f.root, ["rev-parse", ":.env.example"]).toString().trim())
    .toBe("b08e228b4af41952796386a749a1055a8c41b740");
  const result = run(f, revisionProgram(f.app));
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).revision).toBe(oracle(f.root));
  expect(receipt(result.stderr).credential_file_violations).toEqual([]);
});

it("inspects a checkout after Git disables sparse checkout and worktree config", () => {
  const f = fixture();
  git(f.root, ["config", "--local", "extensions.worktreeConfig", "true"]);
  git(f.root, ["sparse-checkout", "disable"]);
  git(f.root, ["config", "--local", "--unset-all", "extensions.worktreeConfig"]);
  const result = run(f, revisionProgram(f.app));
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).revision).toBe(oracle(f.root));
  const evidence = receipt(result.stderr);
  expect(evidence.credential_file_violations).toEqual([]);
  expect(evidence.operations).toHaveLength(3);
  expect(evidence.operations.every((row: { operation: string }) =>
    row.operation === "process.execFileSync.authority-git.allowed")).toBe(true);
});

it("inspects the loaded repository including its public template through both provider-free guards", () => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "loaded-revision-guard-")));
  roots.push(outer);
  const root = realpathSync(repository), f = { root, outer, out: outer, app: bench,
    workset: join(outer, "unused-workset"), preflight: join(outer, "unused-preflight"), cache: join(outer, "unused-cache") };
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
  const expected = oracle(root), result = run(f, revisionProgram(bench), true, [common]);
  expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).revision).toBe(expected);
  const evidence = receipt(result.stderr);
  expect(evidence.credential_file_violations).toEqual([]);
  expect(evidence.operations.length).toBeGreaterThanOrEqual(3);
  expect(evidence.operations.every((row: { operation: string; cwd: string; credential_environment_count: number }) =>
    row.operation === "process.execFileSync.authority-git.allowed" && row.cwd === root &&
    row.credential_environment_count === 0)).toBe(true);
  console.info("CHECKOUT_REVISION_GUARD_RECEIPT", JSON.stringify({ revision: expected,
    credential_file_violations: evidence.credential_file_violations,
    operations: evidence.operations.map(({ stack: _stack, ...row }: { stack: string }) => row) }));
});

it.each(["modified", "same-size edit", "staged replacement", "untracked", "symlink", "tracked symlink", "nested copy"])(
  "refuses a %s public-template lookalike before reading its bytes through Git", kind => {
    const f = fixture(), template = join(f.root, ".env.example");
    if (kind === "modified" || kind === "staged replacement") writeFileSync(template, "authored-not-a-credential\n");
    if (kind === "same-size edit") {
      const bytes = readFileSync(template); bytes[0] = 33; writeFileSync(template, bytes);
    }
    if (kind === "staged replacement") git(f.root, ["add", ".env.example"]);
    if (kind === "untracked") git(f.root, ["rm", "--cached", ".env.example"]);
    if (kind === "symlink" || kind === "tracked symlink") {
      rmSync(template); symlinkSync(join(repository, ".env.example"), template);
      if (kind === "tracked symlink") git(f.root, ["add", ".env.example"]);
    }
    if (kind === "nested copy") {
      mkdirSync(join(f.root, "nested")); cpSync(template, join(f.root, "nested/.env.example"));
      git(f.root, ["add", "nested/.env.example"]);
    }
    const result = run(f, revisionProgram(f.app)), evidence = receipt(result.stderr);
    expect(result.status).not.toBe(0);
    expect(evidence.operations.filter((row: { blocked?: boolean }) => row.blocked)).toHaveLength(1);
    expect(evidence.operations.filter((row: { operation: string }) => row.operation.endsWith("allowed")))
      .toHaveLength(kind === "untracked" ? 3 : 0);
    expect(evidence.credential_file_violations).toEqual([]);
  }
);

it.each([".env", ".env.local", "service.env", ".aws/config", ".azure/token", "credentials.json", "auth.json", ".env.other.example"])(
  "refuses tracked and untracked credential-shaped %s despite the public template", path => {
    const f = fixture(), filename = join(f.root, path);
    mkdirSync(dirname(filename), { recursive: true }); writeFileSync(filename, "authored-not-a-credential\n");
    for (const tracked of [false, true]) {
      if (tracked) git(f.root, ["add", "--force", "--", path]);
      const result = run(f, revisionProgram(f.app)), evidence = receipt(result.stderr);
      expect(result.status).not.toBe(0);
      expect(evidence.operations.filter((row: { operation: string }) => row.operation.endsWith("allowed")))
        .toHaveLength(tracked ? 0 : 3);
      expect(evidence.operations.at(-1)).toMatchObject({ blocked: true });
      expect(evidence.credential_file_violations).toEqual([]);
    }
  }
);

it("does not exempt the public template from provider-free filesystem credential guards", () => {
  const f = fixture(), result = run(f, `import { readFileSync } from "node:fs"; readFileSync(".env.example");`);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Credential file access forbidden");
  expect(receipt(result.stderr).operations).toEqual([]);
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

it.each(["repository_config", "repository_index", "public_template_stat"])(
  "reports only the bounded %s refusal stage without leaking inspected content", stage => {
    const f = fixture(), secret = "never-export-inspected-content";
    if (stage === "repository_config") git(f.root, ["config", "credential.helper", secret]);
    if (stage === "repository_index") writeFileSync(join(f.root, ".git/index"), secret);
    if (stage === "public_template_stat") utimesSync(join(f.root, ".env.example"), 1, 1);
    const result = run(f), evidence = receipt(result.stderr);
    expect(result.status).not.toBe(0);
    expect(evidence.operations).toHaveLength(1);
    expect(evidence.operations[0]).toMatchObject({ operation: "process.execFileSync.authority-context",
      blocked: true, refusal: { stage, category: "policy" } });
    if (stage === "repository_config") expect(evidence.operations[0].refusal).toEqual({
      stage, category: "policy", file_role: "common_config", reason: "entry_not_admitted"
    });
    expect(result.stderr).not.toContain(secret);
    expect(existsSync(f.preflight)).toBe(false);
  }
);

it.each(["accessor", "proxy", "permission"])("retains a bounded denial receipt for an inspection %s error", kind => {
  const f = fixture(), secret = "never-export-inspection-error";
  const program = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const { readCurrentExtractionAuthorityRevision } = await import(${JSON.stringify(
      pathToFileURL(join(f.app, "dist/runs/extraction/authority/inspection.js")).href)});
    const kind = ${JSON.stringify(kind)};
    let error;
    if (kind === 'accessor') error = Object.defineProperty({}, 'code', {get() { throw error; }});
    else if (kind === 'proxy') error = new Proxy({}, {get() { throw error; }, getOwnPropertyDescriptor() { throw error; }});
    else error = Object.assign(new Error(${JSON.stringify(secret)}), {code:'ERR_ACCESS_DENIED',stack:${JSON.stringify(secret)}});
    const original = fs.lstatSync; fs.lstatSync = () => { throw error; }; syncBuiltinESMExports();
    try { readCurrentExtractionAuthorityRevision(); }
    finally { fs.lstatSync = original; syncBuiltinESMExports(); }`;
  const result = run(f, program), evidence = receipt(result.stderr);
  expect(result.status).not.toBe(0);
  expect(evidence.operations).toHaveLength(1);
  expect(evidence.operations[0]).toMatchObject({ operation: "process.execFileSync.authority-context",
    blocked: true, refusal: { stage: "repository_metadata", category: kind === "permission" ? "permission" : "inspection" } });
  expect(result.stderr).not.toContain(secret);
  expect(existsSync(f.preflight)).toBe(false);
});

it("admits checkout's disabled automatic garbage collection without broadening Git operations", () => {
  const f = fixture(); git(f.root, ["config", "--local", "gc.auto", "0"]);
  const expected = oracle(f.root), result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).revision).toBe(expected);
  expect(receipt(result.stderr).operations).toEqual(Array(3).fill(expect.objectContaining({
    operation: "process.execFileSync.authority-git.allowed"
  })));
  expect(existsSync(f.cache)).toBe(false);
});

it.each([
  ["enabled automatic garbage collection", ["gc.auto", "1"]],
  ["negative automatic garbage collection", ["gc.auto", "-1"]],
  ["alternate zero spelling", ["gc.auto", "00"]],
  ["automatic pack collection", ["gc.autoPackLimit", "0"]],
  ["automatic collection detachment", ["gc.autoDetach", "false"]],
  ["GC subsection", ["gc.fixture.auto", "0"]],
  ["hooks path", ["core.hooksPath", "/forbidden"]],
  ["textconv", ["diff.fixture.textconv", "forbidden-helper"]],
  ["external diff", ["diff.external", "forbidden-helper"]],
  ["filter", ["filter.fixture.clean", "forbidden-helper"]],
  ["fsmonitor", ["core.fsmonitor", "forbidden-helper"]],
  ["include", ["include.path", "/forbidden"]],
  ["conditional include", ["includeIf.gitdir:/checkout/.git.path", "/forbidden"]],
  ["alternate worktree", ["core.worktree", "/forbidden"]],
  ["external attributes", ["core.attributesFile", "/forbidden"]],
  ["external excludes", ["core.excludesFile", "/forbidden"]],
  ["promisor", ["remote.origin.promisor", "true"]],
  ["credential helper", ["credential.helper", "forbidden-helper"]],
  ["askpass helper", ["core.askPass", "forbidden-helper"]]
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
