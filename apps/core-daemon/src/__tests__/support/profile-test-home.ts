import os from "node:os";
import path from "node:path";

export const PROFILE_TEST_HOME = path.join(os.tmpdir(), "alaya-test-profile-home");
export const REPO_LAYOUT_ROOT = path.join(os.tmpdir(), "Do SOUL Alaya");

export function createProfileTestEnv(home: string = PROFILE_TEST_HOME): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex")
  };
}

export function codexConfigPath(home: string = PROFILE_TEST_HOME): string {
  return path.join(home, ".codex", "config.toml");
}

export function claudeJsonPath(home: string = PROFILE_TEST_HOME): string {
  return path.join(home, ".claude.json");
}

export function repoSourceAttachDir(repoRoot: string = REPO_LAYOUT_ROOT): string {
  return path.join(repoRoot, "apps", "core-daemon", "src", "attach");
}

export function repoDistAttachDir(repoRoot: string = REPO_LAYOUT_ROOT): string {
  return path.join(repoRoot, "apps", "core-daemon", "dist", "attach");
}

export function repoBinPath(repoRoot: string = REPO_LAYOUT_ROOT): string {
  return path.join(repoRoot, "bin", "alaya.mjs");
}

export function installedPackageDistAttachDir(): string {
  return path.join(os.tmpdir(), "install root", "node_modules", "@do-soul", "alaya", "dist", "attach");
}

export function installedPackageBinPath(): string {
  return path.join(os.tmpdir(), "install root", "node_modules", "@do-soul", "alaya", "bin", "alaya.mjs");
}

export function expectedMcpLauncher(repoRoot: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    command: "node",
    args: [repoBinPath(repoRoot), "mcp", "stdio"]
  };
}
