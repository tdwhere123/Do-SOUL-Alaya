import os from "node:os";
import path from "node:path";
import { quoteSingle } from "./test-paths.js";

export const PROFILE_TEST_HOME = path.join(os.tmpdir(), "alaya-test-profile-home");
export const REPO_LAYOUT_ROOT = path.join(os.tmpdir(), "Do SOUL Alaya");

export function createProfileTestEnv(home: string = PROFILE_TEST_HOME): NodeJS.ProcessEnv {
  return process.platform === "win32"
    ? { HOME: home, USERPROFILE: home }
    : { HOME: home };
}

export function codexConfigPath(home: string = PROFILE_TEST_HOME): string {
  return path.join(home, ".codex", "config.toml");
}

export function codexSlashCommandsPath(home: string = PROFILE_TEST_HOME): string {
  return path.join(home, ".codex", "slash-commands.toml");
}

export function codexSlashCommandsInCommandsDir(home: string = PROFILE_TEST_HOME): string {
  return path.join(home, ".codex", "commands", "slash-commands.toml");
}

export function claudeJsonPath(home: string = PROFILE_TEST_HOME): string {
  return path.join(home, ".claude.json");
}

export function claudeSlashCommandsPath(home: string = PROFILE_TEST_HOME): string {
  return path.join(home, ".claude", "slash-commands.json");
}

export function claudeSlashCommandsInCommandsDir(home: string = PROFILE_TEST_HOME): string {
  return path.join(home, ".claude", "commands", "slash-commands.json");
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

export function expectedSlashCommand(repoRoot: string): string {
  return `node ${quoteSingle(repoBinPath(repoRoot))} inspect --open`;
}

export function expectedInstalledPackageSlashCommand(): string {
  return `node ${quoteSingle(installedPackageBinPath())} inspect --open`;
}
