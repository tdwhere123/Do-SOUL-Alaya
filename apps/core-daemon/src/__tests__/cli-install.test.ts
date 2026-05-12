import { mkdtemp, readFile, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createInstallCommand } from "../cli/install.js";
import type { AlayaCliContext } from "../cli/bridge.js";

describe("cli install", () => {
  it("writes config, secret refs, pasted secrets, and audit rows without plaintext .env keys", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-"));
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock()
    });

    const result = await command.handler(createContext(), {
      nonInteractive: true,
      force: false,
      keychain: false,
      answers: {
        embedding_enabled: true,
        api_key_source: "paste",
        pasted_key: "sk-test-secret",
        provider_base_url: "https://embedding.example.test/v1",
        model_id: "text-embedding-3-large",
        default_workspace: "work",
        worktree_enabled: true
      }
    });

    expect(result.exitCode).toBe(0);
    const toml = await readFile(path.join(configDir, "alaya.toml"), "utf8");
    const env = await readFile(path.join(configDir, ".env"), "utf8");
    const secret = await readFile(path.join(configDir, "secrets", "openai"), "utf8");
    const secretStat = await stat(path.join(configDir, "secrets", "openai"));
    const auditFiles = await readdir(path.join(configDir, "audit"));

    expect(toml).toContain('default_workspace = "work"');
    expect(toml).toContain('provider_base_url = "https://embedding.example.test/v1"');
    expect(toml).toContain('model_id = "text-embedding-3-large"');
    expect(env).toContain("ALAYA_OPENAI_SECRET_REF=file:");
    expect(env).toContain("OPENAI_EMBEDDING_PROVIDER_URL=https://embedding.example.test/v1");
    expect(env).toContain("OPENAI_EMBEDDING_MODEL=text-embedding-3-large");
    expect(env).not.toContain("sk-test-secret");
    expect(secret.trim()).toBe("sk-test-secret");
    expect(secretStat.mode & 0o777).toBe(0o600);
    expect(auditFiles).toHaveLength(1);
    const audit = JSON.parse(await readFile(path.join(configDir, "audit", auditFiles[0]!), "utf8")) as {
      status: string;
      partial_state: string[];
    };
    expect(audit.status).toBe("succeeded");
    expect(audit.partial_state).toEqual(
      expect.arrayContaining([
        path.join(configDir, "secrets", "openai"),
        path.join(configDir, "alaya.toml"),
        path.join(configDir, ".env")
      ])
    );
  });

  it("re-run with accepted defaults leaves config files unchanged and writes only a fresh audit row", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-idempotent-"));
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock()
    });
    const answers = {
      embedding_enabled: true,
      api_key_source: "env" as const,
      env_var_name: "OPENAI_API_KEY",
      default_workspace: "default"
    };

    await command.handler(createContext(), { nonInteractive: true, answers, force: false, keychain: false });
    const tomlBefore = await readFile(path.join(configDir, "alaya.toml"), "utf8");
    const envBefore = await readFile(path.join(configDir, ".env"), "utf8");

    const result = await command.handler(createContext(), {
      nonInteractive: true,
      answers: {},
      force: false,
      keychain: false
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(configDir, "alaya.toml"), "utf8")).toBe(tomlBefore);
    expect(await readFile(path.join(configDir, ".env"), "utf8")).toBe(envBefore);
    const auditFiles = await readdir(path.join(configDir, "audit"));
    expect(auditFiles).toHaveLength(2);
  });

  it("rejects a symlinked secrets directory before writing pasted plaintext", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-symlink-"));
    const leakDir = await mkdtemp(path.join(tmpdir(), "alaya-install-leak-"));
    await symlink(leakDir, path.join(configDir, "secrets"));
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock()
    });

    const result = await command.handler(createContext(), {
      nonInteractive: true,
      force: false,
      keychain: false,
      answers: {
        embedding_enabled: true,
        api_key_source: "paste",
        pasted_key: "sk-install-secret"
      }
    });

    expect(result.exitCode).not.toBe(0);
    expect(await readdir(leakDir)).toEqual([]);
    await expect(readFile(path.join(configDir, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked config directory before writing install artifacts", async () => {
    const parentDir = await mkdtemp(path.join(tmpdir(), "alaya-install-parent-"));
    const leakDir = await mkdtemp(path.join(tmpdir(), "alaya-install-config-leak-"));
    const configDir = path.join(parentDir, "config-link");
    await symlink(leakDir, configDir);
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock()
    });

    const result = await command.handler(createContext(), {
      nonInteractive: true,
      force: false,
      keychain: false,
      answers: {
        embedding_enabled: true,
        api_key_source: "paste",
        pasted_key: "sk-install-secret"
      }
    });

    expect(result.exitCode).not.toBe(0);
    expect(await readdir(leakDir)).toEqual([]);
  });
});

function createClock(): () => string {
  let tick = 0;
  return () => `2026-04-30T00:00:0${tick++}.000Z`;
}

function createContext(): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] }
  };
}
