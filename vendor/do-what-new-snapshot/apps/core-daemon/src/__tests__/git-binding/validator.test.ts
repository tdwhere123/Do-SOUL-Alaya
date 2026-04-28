import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWorkspaceGitBindingStatus,
  validateWorkspaceGitBindingInput
} from "../../git-binding/validator.js";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("git binding validator", () => {
  it("accepts a git repository within the current working directory", async () => {
    const root = await createTempDirectory("cwd-root");
    const repoPath = await createGitRepo(root, "repo");

    await expect(
      validateWorkspaceGitBindingInput(repoPath, {
        currentWorkingDirectory: root,
        repoRootsEnv: ""
      })
    ).resolves.toEqual({
      ok: true,
      repo_path: repoPath
    });
  });

  it("accepts a git repository within DO_WHAT_REPO_ROOTS", async () => {
    const cwdRoot = await createTempDirectory("cwd-root");
    const allowedRoot = await createTempDirectory("allowed-root");
    const repoPath = await createGitRepo(allowedRoot, "repo");

    await expect(
      validateWorkspaceGitBindingInput(repoPath, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: allowedRoot
      })
    ).resolves.toEqual({
      ok: true,
      repo_path: repoPath
    });
  });

  it("rejects traversal attempts including encoded and windows-style segments", async () => {
    const cwdRoot = await createTempDirectory("cwd-root");

    await expect(
      validateWorkspaceGitBindingInput(`${cwdRoot}/../escape`, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: ""
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "path_traversal"
    });

    await expect(
      validateWorkspaceGitBindingInput(`${cwdRoot}/%2e%2e/escape`, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: ""
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "path_traversal"
    });

    await expect(
      validateWorkspaceGitBindingInput(`${cwdRoot}/..\\escape`, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: ""
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "path_traversal"
    });
  });

  it("rejects symlinks that resolve outside the allowlist", async () => {
    const cwdRoot = await createTempDirectory("cwd-root");
    const outsideRoot = await createTempDirectory("outside-root");
    const repoPath = await createGitRepo(outsideRoot, "repo");
    const symlinkPath = path.join(cwdRoot, "linked-repo");
    await symlink(repoPath, symlinkPath, "dir");

    await expect(
      validateWorkspaceGitBindingInput(symlinkPath, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: ""
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "outside_allowed_roots"
    });
  });

  it("rejects .git file indirection when gitdir resolves outside the allowlist", async () => {
    const cwdRoot = await createTempDirectory("cwd-root");
    const outsideRoot = await createTempDirectory("outside-root");
    const repoPath = path.join(cwdRoot, "repo");
    const outsideGitDir = path.join(outsideRoot, "detached-gitdir");

    await mkdir(repoPath, { recursive: true });
    await mkdir(outsideGitDir, { recursive: true });
    await writeFile(path.join(repoPath, ".git"), `gitdir: ${outsideGitDir}\n`, "utf8");

    await expect(
      validateWorkspaceGitBindingInput(repoPath, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: ""
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "outside_allowed_roots"
    });
  });

  it("rejects non-directory targets and directories without .git markers", async () => {
    const cwdRoot = await createTempDirectory("cwd-root");
    const filePath = path.join(cwdRoot, "file.txt");
    await writeFile(filePath, "not a directory", "utf8");
    const plainDirectory = path.join(cwdRoot, "plain-dir");
    await mkdir(plainDirectory, { recursive: true });

    await expect(
      validateWorkspaceGitBindingInput(filePath, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: ""
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "not_a_directory"
    });

    await expect(
      validateWorkspaceGitBindingInput(plainDirectory, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: ""
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "not_a_git_repository"
    });
  });

  it("reports invalid status when an existing binding drifts on disk", async () => {
    const cwdRoot = await createTempDirectory("cwd-root");
    const repoPath = await createGitRepo(cwdRoot, "repo");
    await rm(path.join(repoPath, ".git"), { recursive: true, force: true });

    await expect(
      getWorkspaceGitBindingStatus(repoPath, {
        currentWorkingDirectory: cwdRoot,
        repoRootsEnv: ""
      })
    ).resolves.toMatchObject({
      repo_path: repoPath,
      status: "invalid",
      reason: expect.any(String)
    });
  });
});

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `do-what-c30-${prefix}-`));
  tempDirectories.add(directory);
  return directory;
}

async function createGitRepo(parent: string, name: string): Promise<string> {
  const repoPath = path.join(parent, name);
  await mkdir(path.join(repoPath, ".git"), { recursive: true });
  return repoPath;
}
