import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  // Node loads the emitted runtime; declarations and source maps are not fixture inputs.
  cpSync(join(benchRoot, "dist"), join(bench, "dist"), { recursive: true,
    filter: path => !path.endsWith(".d.ts") && !path.endsWith(".map") });
  const scripts = join(bench, "scripts/longmemeval-replay");
  mkdirSync(scripts, { recursive: true });
  cpSync(join(benchRoot, "scripts/longmemeval-replay/measurement-status.mjs"),
    join(scripts, "measurement-status.mjs"));
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
  chmodSync(untracked, process.platform === "win32" ? 0o444 : 0o755);
  expect(inspect(loaded, foreign).revision).not.toBe(changedBytes);
  writeFileSync(join(foreign, "source.txt"), "foreign-only drift\n");
  expect(inspect(loaded, foreign).revision).toBe(inspect(loaded, loaded).revision);
});

it("binds carriage-return edits when tracked attributes forbid text normalization", () => {
  const loaded = checkout();
  writeFileSync(join(loaded, ".gitattributes"), "*.txt -text\n");
  writeFileSync(join(loaded, "source.txt"), "one\ntwo\n");
  git(loaded, ["add", ".gitattributes", "source.txt"]);
  git(loaded, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "byte-sensitive text"]);
  const baseline = inspect(loaded, loaded).revision;
  writeFileSync(join(loaded, "source.txt"), "one\r\ntwo\n");
  const first = inspect(loaded, loaded).revision;
  writeFileSync(join(loaded, "source.txt"), "one\ntwo\r\n");
  const second = inspect(loaded, loaded).revision;
  expect(first).not.toBe(baseline);
  expect(second).not.toBe(first);
});

it("binds raw tracked changes without invoking a configured textconv helper", () => {
  const loaded = checkout(), marker = join(loaded, "helper-ran");
  writeFileSync(join(loaded, "textconv.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.log("constant");`);
  writeFileSync(join(loaded, ".gitattributes"), "source.txt diff=fixture\n");
  git(loaded, ["add", ".gitattributes", "textconv.cjs"]);
  git(loaded, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "textconv fixture"]);
  git(loaded, ["config", "diff.fixture.textconv", `"${process.execPath}" "${join(loaded, "textconv.cjs")}"`]);
  const baseline = inspect(loaded, loaded).revision;
  writeFileSync(join(loaded, "source.txt"), "first raw change\n");
  const first = inspect(loaded, loaded).revision;
  writeFileSync(join(loaded, "source.txt"), "second raw change\n");
  expect(first).not.toBe(baseline);
  expect(inspect(loaded, loaded).revision).not.toBe(first);
  expect(existsSync(marker)).toBe(false);
  // Independent negative control: the configured authored helper really would run
  // without the authority reader's explicit textconv refusal.
  git(loaded, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]);
  expect(existsSync(marker)).toBe(true);
});

it("preserves authority revision across canonical LF and CRLF checkout bytes", () => {
  const loaded = checkout();
  writeFileSync(join(loaded, ".gitattributes"), "*.txt text\n");
  git(loaded, ["add", ".gitattributes"]);
  git(loaded, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "canonical text"]);
  const baseline = inspect(loaded, loaded).revision;
  writeFileSync(join(loaded, "source.txt"), "original\r\n");
  expect(inspect(loaded, loaded).revision).toBe(baseline);
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

it("reads current revisions with bounded Git processes while preserving raw untracked file identities", () => {
  const loaded = checkout();
  const names = ["space name.txt", "中文.txt", "-option.txt", "quote'file.txt", "binary.bin", "line-endings.txt"];
  for (const name of names) writeFileSync(join(loaded, name), Buffer.from([0, 13, 10, 255]));
  writeFileSync(join(loaded, ".gitattributes"), "*.txt text\n*.bin filter=forbidden\n");
  git(loaded, ["config", "filter.forbidden.clean", "exit 1"]);
  git(loaded, ["config", "filter.forbidden.required", "true"]);
  if (process.platform !== "win32") {
    writeFileSync(join(loaded, "line\nbreak\r.txt"), "raw\r\nbytes");
    symlinkSync("binary.bin", join(loaded, "raw-link"));
  }
  const expected = originalRevision(loaded);
  const modulePath = join(loaded, "apps/bench-runner/dist/runs/extraction/authority/inspection.js");
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { writeFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const original = childProcess.execFileSync;
    let processes = 0;
    childProcess.execFileSync = function(command, ...args) {
      if (command === "git") processes++;
      return original(command, ...args);
    };
    syncBuiltinESMExports();
    const { readCurrentExtractionAuthorityRevision: revision } = await import(pathToFileURL(process.env.MODULE));
    const first = revision(), firstProcesses = processes;
    writeFileSync("binary.bin", Buffer.from([0, 13, 11, 255]));
    const second = revision();
    writeFileSync("source.txt", "modified\\n");
    const third = revision();
    console.log(JSON.stringify({ first, second, third, firstProcesses, processes }));
  `], { cwd: loaded, encoding: "utf8", env: { ...process.env, MODULE: modulePath } })) as {
    first: string; second: string; third: string; firstProcesses: number; processes: number;
  };
  expect(result.first).toBe(expected);
  expect(result.firstProcesses).toBeLessThanOrEqual(4);
  expect(result.processes).toBeLessThanOrEqual(12);
  expect(result.second).not.toBe(result.first);
  expect(result.third).not.toBe(result.second);
});

// Small adversarial fixtures retain the original one-file-at-a-time Git oracle.
// Long-path fixtures use Git's independent stdin framing instead of mirroring argv batching.
function originalRevision(root: string, hashInput: "individual" | "stdin" = "individual"): string {
  const config = ["-c", "core.autocrlf=true", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
  const head = git(root, ["rev-parse", "HEAD"]).toString().trim();
  const digest = createHash("sha256").update("git-worktree-v1\0").update(head).update("\0")
    .update(git(root, [...config, "diff", "--no-ext-diff", "--binary", "HEAD", "--"]));
  const files = git(root, [...config, "ls-files", "--others", "--exclude-standard", "-z"])
    .toString().split("\0").filter(Boolean).sort((a, b) => a.localeCompare(b));
  let blobs: readonly string[];
  if (hashInput === "stdin") {
    // This fixture uses literal newline-free paths; special quoting stays in the small oracle case.
    expect(files.every(path => !/[\r\n"]/u.test(path))).toBe(true);
    blobs = execFileSync("git", [...config, "hash-object", "--no-filters", "--stdin-paths"], {
      cwd: root, input: `${files.join("\n")}\n`, encoding: "utf8"
    }).trim().split(/\r?\n/u);
  } else {
    blobs = files.map(path => git(root, [...config, "hash-object", "--no-filters", "--", path]).toString().trim());
  }
  expect(blobs).toHaveLength(files.length);
  for (const [index, path] of files.entries()) {
    const mode = lstatSync(join(root, path)).mode & 0o777;
    digest.update(`\0${path}\0${mode}\0${blobs[index]}`);
  }
  return `git-worktree-v1:${head}:${digest.digest("hex")}`;
}

it("preserves every raw untracked blob when path arguments span multiple bounded batches", () => {
  const loaded = checkout();
  for (let index = 0; index < 90; index++) {
    const name = `${index}-${"long-name-".repeat(17)}.txt`;
    writeFileSync(join(loaded, name), `source ${index}\r\n`);
  }
  expect(inspect(loaded, loaded).revision).toBe(originalRevision(loaded, "stdin"));
});
