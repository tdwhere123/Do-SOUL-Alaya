import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureGitState } from "../../../runs/provenance/contract/frozen-code-contract.js";
import { assertSafeUntrackedRelativePath } from "../../../runs/provenance/contract/untracked-worktree-frame.js";
import {
  createFrozenCodeFixtureHarness,
  git,
  independentDirtyWorktreeHash
} from "./frozen-code-contract-fixture.js";

const { identityRepository } = createFrozenCodeFixtureHarness();

describe("worktree identity path and repository authority", () => {
  it("includes legal untracked ..foo paths and changes digest when their bytes change", async () => {
    const fixture = await identityRepository();
    expect(() => assertSafeUntrackedRelativePath("..", fixture.root)).toThrow(/normalized/iu);
    expect(() => assertSafeUntrackedRelativePath("../x", fixture.root)).toThrow(/normalized/iu);
    expect(assertSafeUntrackedRelativePath("..foo", fixture.root)).toBe("..foo");
    expect(assertSafeUntrackedRelativePath("foo/..foo", fixture.root)).toBe("foo/..foo");

    await writeFile(join(fixture.root, "..foo"), "dotdot-alpha\n", "utf8");
    await mkdir(join(fixture.root, "foo"));
    await writeFile(join(fixture.root, "foo", "..foo"), "nested-alpha\n", "utf8");
    const first = await measureGitState(fixture.root, { allowDirty: true });
    expect(first.worktreeStateAlgorithm).toBe("sha256-worktree-state-v3");
    expect(first.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));

    await writeFile(join(fixture.root, "..foo"), "dotdot-beta\n", "utf8");
    const changedTop = await measureGitState(fixture.root, { allowDirty: true });
    expect(changedTop.worktreeStateSha256).not.toBe(first.worktreeStateSha256);
    expect(changedTop.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));

    await writeFile(join(fixture.root, "foo", "..foo"), "nested-beta\n", "utf8");
    const changedNested = await measureGitState(fixture.root, { allowDirty: true });
    expect(changedNested.worktreeStateSha256).not.toBe(changedTop.worktreeStateSha256);
    expect(changedNested.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
  });

  it("omits untracked bytes listed in .git/info/exclude from v3", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "kept.ts"), "export const kept = 1;\n", "utf8");
    const baseline = await measureGitState(fixture.root, { allowDirty: true });

    await writeFile(join(fixture.root, "excluded-secret.ts"), "SECRET=info-exclude-bytes\n", "utf8");
    const withSecret = await measureGitState(fixture.root, { allowDirty: true });
    expect(withSecret.worktreeStateSha256).not.toBe(baseline.worktreeStateSha256);

    await writeFile(join(fixture.root, ".git", "info", "exclude"), "excluded-secret.ts\n", "utf8");
    const excluded = await measureGitState(fixture.root, { allowDirty: true });
    expect(excluded.worktreeStateSha256).toBe(baseline.worktreeStateSha256);
    expect(excluded.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
    expect(JSON.stringify(excluded)).not.toContain("info-exclude-bytes");
  });

  it("ignores non-authoritative global core.autocrlf when hashing v3", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "tracked.txt"), "one\n", "utf8");
    await git(fixture.root, "add", "tracked.txt");
    await git(fixture.root, "commit", "--quiet", "-m", "text");
    await writeFile(join(fixture.root, "tracked.txt"), "two\n", "utf8");
    const baseline = await measureGitState(fixture.root, { allowDirty: true });

    const hostileHome = await mkdtemp(join(tmpdir(), "alaya-git-autocrlf-"));
    const globalConfig = join(hostileHome, "gitconfig");
    await writeFile(globalConfig, [
      "[core]",
      "  autocrlf = true",
      "  eol = crlf",
      "  safecrlf = false"
    ].join("\n") + "\n", "utf8");
    const previous = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      HOME: process.env.HOME
    };
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_SYSTEM = globalConfig;
    process.env.HOME = hostileHome;
    try {
      const hostile = await measureGitState(fixture.root, { allowDirty: true });
      expect(hostile.worktreeStateSha256).toBe(baseline.worktreeStateSha256);
      expect(hostile.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
    } finally {
      restoreEnv(previous);
      await rm(hostileHome, { recursive: true, force: true });
    }
  });
});

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
