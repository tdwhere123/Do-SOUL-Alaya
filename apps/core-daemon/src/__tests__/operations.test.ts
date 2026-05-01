import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveAlayaConfigPaths } from "../cli/config-files.js";
import { createAlayaOperationsService } from "../operations.js";

describe("alaya operations", () => {
  it("backs up config and storage into a previewable bundle with an audit row", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-ops-"));
    const paths = resolveAlayaConfigPaths(configDir);
    const dbPath = path.join(configDir, "alaya.db");
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.tomlPath, `[storage]\ndb_path = "${dbPath}"\n`, "utf8");
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
});
