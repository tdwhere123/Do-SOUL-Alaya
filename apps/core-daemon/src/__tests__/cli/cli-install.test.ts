import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createInstallCommand } from "../../cli/install.js";
import { readSecretLine } from "../../cli/install/masked-stdin.js";
import type { AlayaCliContext } from "../../cli/bridge.js";

describe("cli install", () => {
  it("parses keychain install flags without accepting secret material in argv", () => {
    const command = createInstallCommand();

    expect(command.argsSchema.safeParse(["--keychain"])).toMatchObject({
      success: true,
      data: { nonInteractive: false, answers: null, force: false, keychain: true }
    });
    expect(command.argsSchema.safeParse(["--keychain", "--force"])).toMatchObject({
      success: true,
      data: { nonInteractive: false, answers: null, force: true, keychain: true }
    });
    expect(command.argsSchema.safeParse(["--keychain", "--non-interactive"])).toMatchObject({
      success: true,
      data: { nonInteractive: true, answers: null, force: false, keychain: true }
    });

    expect(command.argsSchema.safeParse(["--keychain", "extra"])).toMatchObject({ success: false });
    expect(command.argsSchema.safeParse(["--keychain", "--non-interactive", "extra"])).toMatchObject({
      success: false
    });
  });

  it("restores TTY raw mode after reading a masked keychain secret", async () => {
    const stdin = new PassThrough() as PassThrough & {
      isRaw: boolean;
      setRawMode: (mode: boolean) => typeof stdin;
    };
    const rawModeChanges: boolean[] = [];
    stdin.isRaw = false;
    stdin.setRawMode = (mode: boolean) => {
      rawModeChanges.push(mode);
      stdin.isRaw = mode;
      return stdin;
    };
    const stderr = new PassThrough();

    const read = readSecretLine(stdin, stderr, true);
    stdin.write("sk-secrex");
    stdin.write(Buffer.from([0x7f]));
    stdin.write("t\n");

    await expect(read).resolves.toBe("sk-secret");
    expect(rawModeChanges).toEqual([true, false]);
  });

  it("restores TTY raw mode when setup fails after raw mode is enabled", async () => {
    const stdin = new PassThrough() as PassThrough & {
      isRaw: boolean;
      setRawMode: (mode: boolean) => typeof stdin;
      setEncoding: () => typeof stdin;
    };
    const rawModeChanges: boolean[] = [];
    stdin.isRaw = false;
    stdin.setRawMode = (mode: boolean) => {
      rawModeChanges.push(mode);
      stdin.isRaw = mode;
      return stdin;
    };
    stdin.setEncoding = () => {
      throw new Error("encoding failed");
    };

    await expect(readSecretLine(stdin, new PassThrough(), true)).rejects.toThrow("encoding failed");
    expect(rawModeChanges).toEqual([true, false]);
  });

  it("restores TTY raw mode when input ends before newline", async () => {
    const stdin = new PassThrough() as PassThrough & {
      isRaw: boolean;
      setRawMode: (mode: boolean) => typeof stdin;
    };
    const rawModeChanges: boolean[] = [];
    stdin.isRaw = false;
    stdin.setRawMode = (mode: boolean) => {
      rawModeChanges.push(mode);
      stdin.isRaw = mode;
      return stdin;
    };

    const read = readSecretLine(stdin, new PassThrough(), true);
    stdin.end("partial-secret");

    await expect(read).rejects.toThrow("ended before newline");
    expect(rawModeChanges).toEqual([true, false]);
  });

  it("restores TTY raw mode when input closes before newline", async () => {
    const stdin = new PassThrough() as PassThrough & {
      isRaw: boolean;
      setRawMode: (mode: boolean) => typeof stdin;
    };
    const rawModeChanges: boolean[] = [];
    stdin.isRaw = false;
    stdin.setRawMode = (mode: boolean) => {
      rawModeChanges.push(mode);
      stdin.isRaw = mode;
      return stdin;
    };

    const read = readSecretLine(stdin, new PassThrough(), true);
    stdin.write("partial-secret");
    stdin.destroy();

    await expect(read).rejects.toThrow("closed before newline");
    expect(rawModeChanges).toEqual([true, false]);
  });

  it("writes config, secret refs, and audit rows without plaintext .env keys", async () => {
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
        api_key_source: "env",
        env_var_name: "OPENAI_API_KEY",
        provider_base_url: "https://embedding.example.test/v1",
        model_id: "text-embedding-3-large",
        default_workspace: "work",
        worktree_enabled: true
      }
    });

    expect(result.exitCode).toBe(0);
    const toml = await readFile(path.join(configDir, "alaya.toml"), "utf8");
    const env = await readFile(path.join(configDir, ".env"), "utf8");
    const auditFiles = await readdir(path.join(configDir, "audit"));

    expect(toml).toContain('default_workspace = "work"');
    expect(toml).toContain('provider_base_url = "https://embedding.example.test/v1"');
    expect(toml).toContain('model_id = "text-embedding-3-large"');
    expect(env).toContain("ALAYA_EMBEDDING_PROVIDER=openai");
    expect(env).toContain("ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY");
    expect(env).toContain("OPENAI_EMBEDDING_PROVIDER_URL=https://embedding.example.test/v1");
    expect(env).toContain("OPENAI_EMBEDDING_MODEL=text-embedding-3-large");
    expect(auditFiles).toHaveLength(1);
    const audit = JSON.parse(await readFile(path.join(configDir, "audit", auditFiles[0]!), "utf8")) as {
      status: string;
      partial_state: string[];
    };
    expect(audit.status).toBe("succeeded");
    expect(audit.partial_state).toEqual(
      expect.arrayContaining([
        path.join(configDir, "alaya.toml"),
        path.join(configDir, ".env")
      ])
    );
  });

  it("migrates legacy OpenAI-shaped config to explicit local defaults", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-legacy-"));
    const dbPath = path.join(configDir, "legacy.db");
    await writeFile(path.join(configDir, "alaya.toml"), [
      "[storage]",
      `db_path = ${JSON.stringify(dbPath)}`,
      "",
      "[runtime]",
      'default_workspace = "default"',
      "worktree_enabled = false",
      "",
      "[embedding]",
      "enabled = true",
      'model_id = "text-embedding-3-small"',
      'provider_base_url = "https://legacy-embedding.example.test/v1"',
      ""
    ].join("\n"), "utf8");
    await writeFile(
      path.join(configDir, ".env"),
      "ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY\nOPENAI_EMBEDDING_MODEL=text-embedding-3-small\n",
      "utf8"
    );
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock()
    });

    const result = await command.handler(createContext(), {
      nonInteractive: true,
      answers: {},
      force: false,
      keychain: false
    });

    expect(result.exitCode).toBe(0);
    const env = await readFile(path.join(configDir, ".env"), "utf8");
    const toml = await readFile(path.join(configDir, "alaya.toml"), "utf8");
    expect(env).toContain("ALAYA_EMBEDDING_PROVIDER=local_onnx");
    expect(env).toContain(
      "ALAYA_LOCAL_EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    );
    expect(env).not.toContain("ALAYA_OPENAI_SECRET_REF");
    expect(env).not.toContain("OPENAI_EMBEDDING_PROVIDER_URL");
    expect(toml).toContain(
      'model_id = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"'
    );
    expect(toml).not.toContain("provider_base_url");
  });

  it("normalizes a valid persisted embedding provider", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-provider-normalize-"));
    const dbPath = path.join(configDir, "alaya.db");
    await writeFile(
      path.join(configDir, "alaya.toml"),
      `[storage]\ndb_path = ${JSON.stringify(dbPath)}\n\n[embedding]\nenabled = false\nmodel_id = "text-embedding-3-large"\n`,
      "utf8"
    );
    await writeFile(path.join(configDir, ".env"), "ALAYA_EMBEDDING_PROVIDER= OpenAI \n", "utf8");
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock()
    });

    const result = await command.handler(createContext(), {
      nonInteractive: true,
      answers: {},
      force: false,
      keychain: false
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(configDir, ".env"), "utf8")).toContain(
      "ALAYA_EMBEDDING_PROVIDER=openai"
    );
  });

  it("rejects an invalid persisted embedding provider", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-provider-invalid-"));
    const envBefore = "ALAYA_EMBEDDING_PROVIDER=open_ai\n";
    await writeFile(path.join(configDir, ".env"), envBefore, "utf8");
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock()
    });

    const result = await command.handler(createContext(), {
      nonInteractive: true,
      answers: {},
      force: false,
      keychain: false
    });

    expect(result.exitCode).not.toBe(0);
    expect(await readFile(path.join(configDir, ".env"), "utf8")).toBe(envBefore);
    const auditFiles = await readdir(path.join(configDir, "audit"));
    const audit = JSON.parse(
      await readFile(path.join(configDir, "audit", auditFiles[0]!), "utf8")
    ) as { readonly status: string; readonly error: string };
    expect(audit).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/ALAYA_EMBEDDING_PROVIDER/)
    });
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
        api_key_source: "env",
        env_var_name: "OPENAI_API_KEY",
        default_workspace: "default"
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
    cwd: path.join(tmpdir(), "alaya-install-cwd"),
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] }
  };
}
