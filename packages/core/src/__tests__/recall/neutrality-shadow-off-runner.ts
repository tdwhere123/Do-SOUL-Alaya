import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NeutralityBundle } from "./neutrality-shadow-fixture.js";
import { SHADOW_OFF_SHA } from "./neutrality-shadow-fixture.js";

const FIXTURE_NAMES = [
  "neutrality-shadow-fixture.ts",
  "neutrality-shadow-capture.test.ts"
] as const;

const RECALL_TEST_DIR = "packages/core/src/__tests__/recall";
const WORKTREE_PARENT_PREFIX = "alaya-shadow-off-";

export function captureShadowOffBundle(): NeutralityBundle {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const currentRoot = git(["rev-parse", "--show-toplevel"], here);
  const mainRoot = resolveMainCheckoutRoot(here);
  const forbidden = collectForbiddenRoots(currentRoot, mainRoot);
  assertOptionalQueryProofBaseSha();
  const worktreeRoot = addIsolatedShadowOffWorktree(currentRoot, forbidden);
  const outFile = path.join(
    mkdtempSync(path.join(tmpdir(), "alaya-neutrality-")),
    "shadow-off.json"
  );
  try {
    const destDir = resolveShadowOffCopyRoot(worktreeRoot, forbidden);
    copyCaptureFiles(here, destDir);
    linkMainNodeModules(mainRoot, worktreeRoot);
    runShadowOffVitest(worktreeRoot, outFile);
    return JSON.parse(readFileSync(outFile, "utf8")) as NeutralityBundle;
  } finally {
    removeIsolatedWorktree(currentRoot, worktreeRoot);
  }
}

export function resolveMainCheckoutRoot(from: string): string {
  const common = git(["rev-parse", "--git-common-dir"], from);
  // Relative --git-common-dir is vs the git cwd, not toplevel.
  const gitDir = path.isAbsolute(common) ? common : path.resolve(from, common);
  return path.dirname(gitDir);
}

export function createShadowOffWorktreePath(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), WORKTREE_PARENT_PREFIX)),
    "checkout"
  );
}

export function resolveShadowOffCopyRoot(
  worktreeRoot: string,
  forbiddenRoots: readonly string[]
): string {
  assertUnderTmpdir(worktreeRoot);
  const destDir = path.join(path.resolve(worktreeRoot), RECALL_TEST_DIR);
  for (const forbidden of forbiddenRoots) {
    assertIsolatedShadowOffDest(destDir, forbidden);
  }
  return destDir;
}

export function assertIsolatedShadowOffDest(
  dest: string,
  forbiddenRoot: string
): void {
  const resolvedDest = path.resolve(dest);
  const resolvedRoot = path.resolve(forbiddenRoot);
  if (isInsideRoot(resolvedDest, resolvedRoot)) {
    throw new Error(
      `shadow-off dest ${resolvedDest} must not be inside ${resolvedRoot}`
    );
  }
}

function addIsolatedShadowOffWorktree(
  repoRoot: string,
  forbiddenRoots: readonly string[]
): string {
  assertShadowOffShaResolves(repoRoot);
  const worktreeRoot = createShadowOffWorktreePath();
  try {
    assertIsolatedWorktreePath(worktreeRoot, forbiddenRoots);
    git(
      ["worktree", "add", "--detach", worktreeRoot, SHADOW_OFF_SHA],
      repoRoot
    );
    assertShadowOffHead(worktreeRoot);
    return worktreeRoot;
  } catch (error) {
    removeIsolatedWorktree(repoRoot, worktreeRoot);
    throw error;
  }
}

function assertIsolatedWorktreePath(
  worktreeRoot: string,
  forbiddenRoots: readonly string[]
): void {
  const resolved = path.resolve(worktreeRoot);
  assertUnderTmpdir(resolved);
  for (const forbidden of forbiddenRoots) {
    assertIsolatedShadowOffDest(resolved, forbidden);
  }
}

function collectForbiddenRoots(
  currentRoot: string,
  mainRoot: string
): readonly string[] {
  const roots = [path.resolve(currentRoot), path.resolve(mainRoot)];
  const override = process.env.QUERY_PROOF_BASE_ROOT;
  if (override !== undefined && override.length > 0) {
    roots.push(path.resolve(override));
  }
  return roots;
}

function assertOptionalQueryProofBaseSha(): void {
  const override = process.env.QUERY_PROOF_BASE_ROOT;
  if (override === undefined || override.length === 0) {
    return;
  }
  assertShadowOffHead(override);
}

function removeIsolatedWorktree(repoRoot: string, worktreeRoot: string): void {
  try {
    git(["worktree", "remove", "--force", worktreeRoot], repoRoot);
  } catch {
    // prune below still drops a stale registration after a failed add/remove
  }
  try {
    git(["worktree", "prune"], repoRoot);
  } catch {
    // temp directory removal must still run
  }
  removeWorktreeParent(worktreeRoot);
}

function removeWorktreeParent(worktreeRoot: string): void {
  const parent = path.dirname(path.resolve(worktreeRoot));
  const tmp = path.resolve(tmpdir());
  if (parent === tmp || !parent.startsWith(`${tmp}${path.sep}`)) {
    return;
  }
  if (!path.basename(parent).startsWith(WORKTREE_PARENT_PREFIX)) {
    return;
  }
  rmSync(parent, { recursive: true, force: true });
}

function copyCaptureFiles(sourceDir: string, destDir: string): void {
  for (const name of FIXTURE_NAMES) {
    copyFileSync(path.join(sourceDir, name), path.join(destDir, name));
  }
}

function linkMainNodeModules(mainRoot: string, worktreeRoot: string): void {
  const rootModules = path.join(mainRoot, "node_modules");
  if (!existsSync(rootModules)) {
    throw new Error(
      `shadow-off capture needs ${rootModules}; will not pnpm install`
    );
  }
  linkDir(rootModules, path.join(worktreeRoot, "node_modules"));
  // Isolated checkout has package sources but not their installs; vitest
  // still loads every workspace project config, including inspector web.
  for (const rel of packageDirs(mainRoot)) {
    linkDir(
      path.join(mainRoot, rel, "node_modules"),
      path.join(worktreeRoot, rel, "node_modules")
    );
  }
}

function packageDirs(root: string): readonly string[] {
  return git(["ls-files", "--", "**/package.json"], root)
    .split("\n")
    .flatMap((file) => {
      if (file.length === 0) return [];
      const dir = path.dirname(file);
      return dir === "." ? [] : [dir];
    });
}

function linkDir(source: string, dest: string): void {
  if (!existsSync(source) || existsSync(dest) || !existsSync(path.dirname(dest))) {
    return;
  }
  symlinkSync(source, dest, "dir");
}

function runShadowOffVitest(root: string, outFile: string): void {
  execFileSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "@do-soul/alaya-core",
      "packages/core/src/__tests__/recall/neutrality-shadow-capture.test.ts"
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NEUTRALITY_CAPTURE_OUT: outFile
      },
      timeout: 120_000
    }
  );
}

function assertShadowOffShaResolves(from: string): void {
  const resolved = git(
    ["rev-parse", "--verify", `${SHADOW_OFF_SHA}^{commit}`],
    from
  );
  if (resolved !== SHADOW_OFF_SHA) {
    throw new Error(
      `resolved shadow-off SHA is ${resolved}, expected ${SHADOW_OFF_SHA}`
    );
  }
}

function assertShadowOffHead(root: string): void {
  const head = git(["rev-parse", "HEAD"], root);
  if (head !== SHADOW_OFF_SHA) {
    throw new Error(
      `shadow-off root ${root} HEAD is ${head}, expected ${SHADOW_OFF_SHA}`
    );
  }
}

function assertUnderTmpdir(target: string): void {
  const resolved = path.resolve(target);
  const tmp = path.resolve(tmpdir());
  if (resolved !== tmp && !resolved.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(`shadow-off path ${resolved} is not under ${tmp}`);
  }
}

function isInsideRoot(inner: string, outer: string): boolean {
  if (inner === outer) {
    return true;
  }
  const prefix = outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`;
  return inner.startsWith(prefix);
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}
