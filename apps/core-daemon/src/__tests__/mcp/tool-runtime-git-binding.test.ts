import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAffectedPathRoots } from "../../mcp/tool-runtime/tool-runtime-files.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function createWorktree() {
  const root = await mkdtemp(path.join(tmpdir(), "alaya-tool-git-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  execFileSync("git", ["init", repo], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktree], { stdio: "pipe" });
  return { root, repo, worktree };
}

describe("tool runtime repository binding", () => {
  it("retains the affected-path boundary for a standard Git worktree", async () => {
    const { root, worktree } = await createWorktree();
    expect(await resolveAffectedPathRoots(worktree, {
      currentWorkingDirectory: root, repoRootsEnv: ""
    })).toEqual([worktree]);
  });

  it("uses explicitly allowed roots for a worktree's external gitdir", async () => {
    const { repo, worktree } = await createWorktree();
    expect(await resolveAffectedPathRoots(worktree, {
      currentWorkingDirectory: worktree, repoRootsEnv: ""
    })).toBeUndefined();
    expect(await resolveAffectedPathRoots(worktree, {
      currentWorkingDirectory: worktree, repoRootsEnv: repo
    })).toEqual([worktree]);
  });

  it("rejects a binding whose Git metadata disappeared after registration", async () => {
    const { root, worktree } = await createWorktree();
    const marker = await readFile(path.join(worktree, ".git"), "utf8");
    await writeFile(path.join(worktree, ".git"), `${marker.trim()}-missing\n`);
    expect(await resolveAffectedPathRoots(worktree, {
      currentWorkingDirectory: root, repoRootsEnv: ""
    })).toBeUndefined();
  });
});
