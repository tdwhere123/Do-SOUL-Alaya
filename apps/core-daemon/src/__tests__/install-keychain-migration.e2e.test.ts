import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { RuntimeGardenComputeConfigSchema, type RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteConfigRepo } from "@do-soul/alaya-storage";
import { describe, expect, it, vi } from "vitest";
import { ALAYA_SYSEXITS, type AlayaCliContext } from "../cli/bridge.js";
import { createDoctorCommand } from "../cli/doctor.js";
import { createInstallCommand } from "../cli/install.js";
import { resolveSecretRef } from "../secrets/index.js";

describe("install keychain migration", () => {
  it("writes a dedicated Garden keychain ref while preserving the existing embedding secret ref", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-keychain-"));
    const envBefore = [
      "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=true",
      "ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY",
      "OPENAI_EMBEDDING_MODEL=text-embedding-3-small"
    ].join("\n");
    await writeFile(path.join(configDir, ".env"), `${envBefore}\n`, "utf8");

    const checkAvailable = vi.fn(() => ({ ok: true as const }));
    const writeKeychain = vi.fn(() => ({ ok: true as const }));
    const readKeychain = vi.fn(() => "sk-keychain-secret");
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock(),
      keychain: { checkAvailable, writeKeychain, readKeychain }
    });
    const ctx = createContext("sk-keychain-secret\n");

    const result = await command.handler(ctx, {
      nonInteractive: false,
      answers: null,
      force: false,
      keychain: true
    });

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(checkAvailable).toHaveBeenCalledWith("alaya", "openai");
    expect(writeKeychain).toHaveBeenCalledWith("alaya", "openai", "sk-keychain-secret");
    expect(readKeychain).toHaveBeenCalledWith("alaya", "openai");

    const envAfter = await readFile(path.join(configDir, ".env"), "utf8");
    expect(envAfter).toContain("ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY\n");
    expect(envAfter).toContain("ALAYA_OFFICIAL_GARDEN_SECRET_REF=keychain:alaya:openai\n");
    expect(envAfter).not.toContain("sk-keychain-secret");
    expect(ctx.stdout.text()).not.toContain("sk-keychain-secret");
    expect(ctx.stderr.text()).not.toContain("sk-keychain-secret");

    const auditFiles = await readdir(path.join(configDir, "audit"));
    expect(auditFiles).toHaveLength(1);
    const audit = JSON.parse(await readFile(path.join(configDir, "audit", auditFiles[0]!), "utf8")) as {
      readonly status: string;
      readonly partial_state: readonly string[];
    };
    expect(audit.status).toBe("succeeded");
    expect(audit.partial_state).toEqual([path.join(configDir, ".env")]);
  });

  it("does not echo the interactive secret on the TTY prompt path", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-keychain-tty-"));
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock(),
      keychain: {
        checkAvailable: () => ({ ok: true as const }),
        writeKeychain: () => ({ ok: true as const }),
        readKeychain: () => "sk-keychain-secret"
      }
    });
    const ctx = createContext("sk-keychain-secret\n", { isTTY: true });

    const result = await command.handler(ctx, {
      nonInteractive: false,
      answers: null,
      force: false,
      keychain: true
    });

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(ctx.stderr.text()).toContain("Enter secret for keychain:alaya:openai:");
    expect(ctx.stderr.text()).not.toContain("sk-keychain-secret");
  });

  it("rejects non-interactive keychain install before accepting secret material", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-keychain-noninteractive-"));
    const writeKeychain = vi.fn(() => ({ ok: true as const }));
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      keychain: {
        checkAvailable: () => ({ ok: true as const }),
        writeKeychain,
        readKeychain: () => "sk-keychain-secret"
      }
    });
    const ctx = createContext();

    const result = await command.handler(ctx, {
      nonInteractive: true,
      answers: null,
      force: false,
      keychain: true
    });

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.USAGE);
    expect(ctx.stderr.text()).toContain("install --keychain requires interactive input");
    expect(writeKeychain).not.toHaveBeenCalled();
  });

  it("honors the failed-audit guard before writing keychain state", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-keychain-audit-"));
    await mkdir(path.join(configDir, "audit"));
    await writeFile(
      path.join(configDir, "audit", "install-2026-05-12T00-00-00.000Z.json"),
      `${JSON.stringify({ status: "failed" })}\n`,
      "utf8"
    );
    const writeKeychain = vi.fn(() => ({ ok: true as const }));
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      keychain: {
        checkAvailable: () => ({ ok: true as const }),
        writeKeychain,
        readKeychain: () => "sk-keychain-secret"
      }
    });
    const ctx = createContext("sk-keychain-secret\n");

    const result = await command.handler(ctx, {
      nonInteractive: false,
      answers: null,
      force: false,
      keychain: true
    });

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.TEMPFAIL);
    expect(writeKeychain).not.toHaveBeenCalled();
    expect(ctx.stderr.text()).toContain("previous install audit");
    await expect(readFile(path.join(configDir, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates a persisted file-ref Garden config and doctor reports keychain OK", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-keychain-file-ref-"));
    const oldSecretPath = path.join(configDir, "secrets", "garden-openai");
    const dbPath = path.join(configDir, "alaya.db");
    await mkdir(path.dirname(oldSecretPath), { recursive: true });
    await writeFile(oldSecretPath, "old-secret\n", "utf8");
    const envBefore = `ALAYA_OPENAI_SECRET_REF=file:${oldSecretPath}\n`;
    await writeFile(path.join(configDir, ".env"), envBefore, "utf8");
    await writeFile(
      path.join(configDir, "alaya.toml"),
      `[storage]\ndb_path = ${JSON.stringify(dbPath)}\n`,
      "utf8"
    );
    const configRepo = new SqliteConfigRepo(initDatabase({ filename: dbPath }));
    configRepo.set<RuntimeGardenComputeConfig>("runtime:garden-compute", {
      provider_kind: "official_api",
      model_id: "gpt-4.1-mini",
      provider_url: "https://api.openai.test/v1",
      secret_ref: `file:${oldSecretPath}`,
      enabled: true
    });
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock(),
      keychain: {
        checkAvailable: () => ({ ok: true as const }),
        writeKeychain: () => ({ ok: true as const }),
        readKeychain: () => "sk-keychain-secret"
      }
    });
    const ctx = createContext("sk-keychain-secret\n");

    const result = await command.handler(ctx, {
      nonInteractive: false,
      answers: null,
      force: false,
      keychain: true
    });

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(await readFile(path.join(configDir, ".env"), "utf8")).toContain(envBefore);

    const persisted = RuntimeGardenComputeConfigSchema.parse(
      configRepo.get<RuntimeGardenComputeConfig>("runtime:garden-compute")
    );
    expect(persisted.secret_ref).toBe("keychain:alaya:openai");
    expect(persisted.provider_kind).toBe("official_api");
    expect(persisted.enabled).toBe(true);

    const resolved = resolveSecretRef(persisted.secret_ref!, {
      readEnv: () => undefined,
      readFile: () => {
        throw new Error("file ref should not be read after keychain migration");
      },
      readKeychain: (service, account) => `${service}:${account}:secret`
    });
    expect(resolved).toMatchObject({
      ref: "keychain:alaya:openai",
      value: "alaya:openai:secret",
      origin: "keychain"
    });

    const doctor = createDoctorCommand({
      getToolchainStatus: async () => ({
        db_path: dbPath,
        files_dir: path.join(configDir, "files"),
        active_worktrees: 0,
        tools: {}
      }),
      getGardenCompute: () => ({
        provider_kind: persisted.provider_kind,
        model_id: persisted.model_id,
        provider_url: persisted.provider_url,
        credential_source: { kind: "keychain", service: "alaya", account: "openai" },
        routing_decision: "official_api",
        keychain_check: { ok: true, service: "alaya", account: "openai" }
      }),
      clock: createClock()
    });
    const doctorResult = await doctor.handler(createContext(), {
      workspaceId: null,
      reconcileBootstrap: false
    });
    const report = doctorResult.json as { readonly garden_compute: { readonly keychain_check?: { readonly ok: boolean } } };
    expect(report.garden_compute.keychain_check).toEqual({ ok: true, service: "alaya", account: "openai" });
  });

  it("patches only the persisted Garden secret_ref and audits the DB-row change", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-keychain-preserve-garden-"));
    const oldSecretPath = path.join(configDir, "secrets", "garden-openai");
    const dbPath = path.join(configDir, "alaya.db");
    await mkdir(path.dirname(oldSecretPath), { recursive: true });
    await writeFile(oldSecretPath, "old-secret\n", "utf8");
    await writeFile(
      path.join(configDir, "alaya.toml"),
      `[storage]\ndb_path = ${JSON.stringify(dbPath)}\n`,
      "utf8"
    );
    const database = initDatabase({ filename: dbPath });
    const configRepo = new SqliteConfigRepo(database);
    configRepo.set<RuntimeGardenComputeConfig>("runtime:garden-compute", {
      provider_kind: "host_worker",
      model_id: "gpt-4.1-mini",
      provider_url: "https://api.openai.test/v1",
      secret_ref: `file:${oldSecretPath}`,
      enabled: false
    });
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      clock: createClock(),
      keychain: {
        checkAvailable: () => ({ ok: true as const }),
        writeKeychain: () => ({ ok: true as const }),
        readKeychain: () => "sk-keychain-secret"
      }
    });

    const result = await command.handler(createContext("sk-keychain-secret\n"), {
      nonInteractive: false,
      answers: null,
      force: false,
      keychain: true
    });

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    const persisted = RuntimeGardenComputeConfigSchema.parse(
      configRepo.get<RuntimeGardenComputeConfig>("runtime:garden-compute")
    );
    expect(persisted).toMatchObject({
      provider_kind: "host_worker",
      enabled: false,
      secret_ref: "keychain:alaya:openai"
    });

    const auditFiles = await readdir(path.join(configDir, "audit"));
    const audit = JSON.parse(await readFile(path.join(configDir, "audit", auditFiles[0]!), "utf8")) as {
      readonly config_changes?: readonly unknown[];
    };
    expect(audit.config_changes).toEqual([
      {
        key: "runtime:garden-compute",
        before: {
          provider_kind: "host_worker",
          enabled: false,
          secret_ref: `file:${oldSecretPath}`
        },
        after: {
          provider_kind: "host_worker",
          enabled: false,
          secret_ref: "keychain:alaya:openai"
        }
      }
    ]);
    expect(JSON.stringify(audit)).not.toContain("sk-keychain-secret");

    const eventRows = database.connection
      .prepare(
        `SELECT event_type, entity_type, entity_id, caused_by, payload_json
         FROM event_log
         WHERE entity_type = 'runtime_config' AND entity_id = 'runtime:garden-compute'`
      )
      .all() as readonly {
      readonly event_type: string;
      readonly entity_type: string;
      readonly entity_id: string;
      readonly caused_by: string | null;
      readonly payload_json: string;
    }[];
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      event_type: "soul.health_journal.recorded",
      entity_type: "runtime_config",
      entity_id: "runtime:garden-compute",
      caused_by: "install"
    });
    expect(JSON.parse(eventRows[0]!.payload_json)).toMatchObject({
      change_summary: {
        fields_changed: ["secret_ref"],
        secret_ref_kind: "keychain"
      }
    });
  });

  it("fails keychain install before config mutation when platform tooling is unavailable", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-install-keychain-tooling-"));
    const envBefore = "ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY\n";
    await writeFile(path.join(configDir, ".env"), envBefore, "utf8");
    const writeKeychain = vi.fn(() => ({ ok: true as const }));
    const command = createInstallCommand({
      configDirResolver: () => configDir,
      keychain: {
        checkAvailable: () => ({
          kind: "keychain_tooling_unavailable" as const,
          service: "alaya",
          account: "openai",
          reason: "secret-tool is not installed"
        }),
        writeKeychain,
        readKeychain: () => "sk-keychain-secret"
      }
    });
    const ctx = createContext("sk-keychain-secret\n");

    const result = await command.handler(ctx, {
      nonInteractive: false,
      answers: null,
      force: false,
      keychain: true
    });

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.TEMPFAIL);
    expect(writeKeychain).not.toHaveBeenCalled();
    expect(await readFile(path.join(configDir, ".env"), "utf8")).toBe(envBefore);
    expect(ctx.stderr.text()).toContain("secret-tool is not installed");
    expect(ctx.stderr.text()).not.toContain("sk-keychain-secret");
  });

  it.each([
    {
      platform: "darwin" as const,
      remediation:
        "Remove the orphaned macOS Keychain item with: security delete-generic-password -s alaya -a openai."
    },
    {
      platform: "linux" as const,
      remediation:
        "Remove the orphaned libsecret item with: secret-tool clear service alaya account openai."
    },
    {
      platform: "win32" as const,
      remediation:
        "Remove the orphaned Windows Credential Manager item via the Credential Manager UI or by removing the Windows.Security.Credentials.PasswordCredential for service alaya account openai."
    }
  ])(
    "audits a $platform keychain orphan with a per-platform delete cmd when verification fails",
    async ({ platform, remediation }) => {
      const configDir = await mkdtemp(path.join(tmpdir(), `alaya-install-keychain-verify-${platform}-`));
      const envBefore = "ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY\n";
      await writeFile(path.join(configDir, ".env"), envBefore, "utf8");
      const command = createInstallCommand({
        configDirResolver: () => configDir,
        platform,
        keychain: {
          checkAvailable: () => ({ ok: true as const }),
          writeKeychain: () => ({ ok: true as const }),
          readKeychain: () => ({
            kind: "keychain_entry_not_found" as const,
            service: "alaya",
            account: "openai",
            reason: "entry not found"
          })
        }
      });
      const ctx = createContext("sk-keychain-secret\n");

      const result = await command.handler(ctx, {
        nonInteractive: false,
        answers: null,
        force: false,
        keychain: true
      });

      expect(result.exitCode).toBe(ALAYA_SYSEXITS.CANTCREAT);
      expect(await readFile(path.join(configDir, ".env"), "utf8")).toBe(envBefore);
      expect(ctx.stderr.text()).toContain("keychain write verification failed");
      expect(ctx.stderr.text()).not.toContain("sk-keychain-secret");

      const auditFiles = await readdir(path.join(configDir, "audit"));
      const audit = JSON.parse(await readFile(path.join(configDir, "audit", auditFiles[0]!), "utf8")) as {
        readonly keychain_orphan?: unknown;
      };
      expect(audit.keychain_orphan).toEqual({
        secret_ref: "keychain:alaya:openai",
        service: "alaya",
        account: "openai",
        remediation
      });
      expect(JSON.stringify(audit)).not.toContain("sk-keychain-secret");
    }
  );
});

function createClock(): () => string {
  let tick = 0;
  return () => `2026-05-12T00:00:0${tick++}.000Z`;
}

interface CapturedCliContext extends AlayaCliContext {
  readonly stdout: MemoryWritable;
  readonly stderr: MemoryWritable;
}

function createContext(
  stdinText = "",
  options: Readonly<{ readonly isTTY?: boolean }> = {}
): CapturedCliContext {
  const stdin = new PassThrough();
  stdin.end(stdinText);
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: options.isTTY ?? false
  });
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin,
    stdout: new MemoryWritable(),
    stderr: new MemoryWritable(),
    isTTY: options.isTTY ?? false,
    daemon: { startupSteps: [] }
  };
}

class MemoryWritable extends Writable {
  private readonly chunks: string[] = [];

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}
