import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAlayaConfigPaths } from "../../cli/support/config-files.js";
import { createAlayaOperationsService } from "../../cli/operations/operations-service.js";
import * as storagePointerFile from "../../runtime/config/storage-pointer-file.js";
import { quoteTomlString } from "../support/test-paths.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("alaya operations", () => {
  it("backs up config and storage into a previewable bundle with an audit row", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-ops-"));
    const paths = resolveAlayaConfigPaths(configDir);
    const dbPath = path.join(configDir, "alaya.db");
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.tomlPath, `[storage]\ndb_path = ${quoteTomlString(dbPath)}\n`, "utf8");
    await writeFile(paths.envPath, "ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY\n", "utf8");
    await writeFile(dbPath, "sqlite-bytes");

    const service = createAlayaOperationsService({
      configPaths: paths,
      clock: () => "2026-04-30T00:00:00.000Z"
    });
    const result = await service.backup();
    const bundle = JSON.parse(await readFile(result.artifact_path, "utf8")) as {
      kind: string;
      storage: { db_path: string; db_base64: string };
    };
    const audit = JSON.parse(await readFile(result.audit_path, "utf8")) as {
      operation: string;
      status: string;
    };

    expect(bundle.kind).toBe("backup");
    expect(Buffer.from(bundle.storage.db_base64, "base64").toString("utf8")).toBe("sqlite-bytes");
    expect(audit).toMatchObject({ operation: "backup", status: "succeeded" });
    await expect(service.previewImport({ bundlePath: result.artifact_path })).resolves.toMatchObject({
      bundle_kind: "backup",
      has_config_toml: true,
      has_env_file: true,
      has_database_payload: true,
      db_path: dbPath
    });
  });

  it("imports database payloads only into the active configured storage path", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-ops-import-"));
    const paths = resolveAlayaConfigPaths(configDir);
    const activeDbPath = path.join(configDir, "active.db");
    const bundledDbPath = path.join(configDir, "attacker.db");
    const bundlePath = path.join(configDir, "bundle.json");
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.tomlPath, `[storage]\ndb_path = ${quoteTomlString(activeDbPath)}\n`, "utf8");
    await writeFile(activeDbPath, "original-bytes");
    await writeFile(
      bundlePath,
      JSON.stringify({
        bundle_version: 1,
        kind: "backup",
        created_at: "2026-05-02T00:00:00.000Z",
        config: {
          alaya_toml: `[storage]\ndb_path = ${quoteTomlString(bundledDbPath)}\n`,
          env_file: null
        },
        storage: {
          db_path: bundledDbPath,
          db_base64: Buffer.from("restored-bytes").toString("base64")
        }
      }),
      "utf8"
    );

    const service = createAlayaOperationsService({
      configPaths: paths,
      clock: () => "2026-05-02T00:00:00.000Z"
    });
    const result = await service.importBundle({ bundlePath });

    expect(result.restored_paths).toContain(activeDbPath);
    expect(result.restored_paths).not.toContain(bundledDbPath);
    await expect(readFile(activeDbPath, "utf8")).resolves.toBe("restored-bytes");
    await expect(readFile(bundledDbPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.tomlPath, "utf8")).resolves.toContain(`db_path = ${quoteTomlString(activeDbPath)}`);
  });

  it("maps empty Error.message in a failed backup audit to unknown_error", async () => {
    const { service, paths } = await createBackupFixture();
    const originalWrite = storagePointerFile.writeTextAtomic;
    vi.spyOn(storagePointerFile, "writeTextAtomic").mockImplementation(async (filePath, content, mode) => {
      if (path.dirname(path.resolve(filePath)) === path.resolve(paths.operationsDir)) {
        throw new Error("");
      }
      return await originalWrite(filePath, content, mode);
    });

    await expect(service.backup()).rejects.toThrow();
    const audit = JSON.parse(
      await readFile(path.join(paths.auditDir, "backup-2026-04-30T00-00-00.000Z.json"), "utf8")
    ) as { status: string; error: string | null };

    expect(audit).toMatchObject({ operation: "backup", status: "failed", error: "unknown_error" });
  });

  it("maps whitespace-only Error.message in a failed backup audit to unknown_error", async () => {
    const { service, paths } = await createBackupFixture();
    const originalWrite = storagePointerFile.writeTextAtomic;
    vi.spyOn(storagePointerFile, "writeTextAtomic").mockImplementation(async (filePath, content, mode) => {
      if (path.dirname(path.resolve(filePath)) === path.resolve(paths.operationsDir)) {
        throw new Error("   ");
      }
      return await originalWrite(filePath, content, mode);
    });

    await expect(service.backup()).rejects.toThrow();
    const audit = JSON.parse(
      await readFile(path.join(paths.auditDir, "backup-2026-04-30T00-00-00.000Z.json"), "utf8")
    ) as { error: string | null };

    expect(audit.error).toBe("unknown_error");
  });
});

async function createBackupFixture(): Promise<{
  readonly service: ReturnType<typeof createAlayaOperationsService>;
  readonly paths: ReturnType<typeof resolveAlayaConfigPaths>;
}> {
  const configDir = await mkdtemp(path.join(tmpdir(), "alaya-ops-empty-"));
  const paths = resolveAlayaConfigPaths(configDir);
  const dbPath = path.join(configDir, "alaya.db");
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.tomlPath, `[storage]\ndb_path = ${quoteTomlString(dbPath)}\n`, "utf8");
  await writeFile(paths.envPath, "ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY\n", "utf8");
  await writeFile(dbPath, "sqlite-bytes");
  return {
    paths,
    service: createAlayaOperationsService({
      configPaths: paths,
      clock: () => "2026-04-30T00:00:00.000Z"
    })
  };
}
