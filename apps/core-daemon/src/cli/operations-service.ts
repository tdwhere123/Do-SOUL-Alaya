import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildOperationAuditPath,
  type AlayaConfigPaths
} from "./config-files.js";
import {
  AlayaOperationError,
  type AlayaOperationsService,
  type ImportPreview,
  type OperationAuditRecord,
  type OperationsBundle
} from "./operations-types.js";
import { parseStorageDbPathFromToml, resolveConfiguredDatabasePath } from "../runtime/index.js";
import {
  replaceStorageDbPathInToml,
  writeTextAtomic
} from "../runtime/config/storage-pointer-file.js";
import { readBundle } from "./operations-bundle-reader.js";

export type { AlayaOperationsService, ImportPreview, OperationAuditRecord, OperationName, OperationsBundle } from "./operations-types.js";
export { AlayaOperationError } from "./operations-types.js";

export interface AlayaOperationsServiceDependencies {
  readonly configPaths: AlayaConfigPaths;
  readonly clock?: () => string;
}

export function createAlayaOperationsService(
  deps: AlayaOperationsServiceDependencies
): AlayaOperationsService {
  const now = deps.clock ?? (() => new Date().toISOString());

  return {
    backup: async (input = {}) =>
      await writeBundleArtifact(deps.configPaths, "backup", now, input.outputPath),
    exportBundle: async (input = {}) =>
      await writeBundleArtifact(deps.configPaths, "export", now, input.outputPath),
    previewImport: async ({ bundlePath }) => await previewBundleImport(bundlePath),
    importBundle: async ({ bundlePath }) =>
      await importOperationsBundle(deps.configPaths, now, bundlePath)
  };
}

async function writeBundleArtifact(
  configPaths: AlayaConfigPaths,
  operation: "backup" | "export",
  now: () => string,
  outputPath: string | null | undefined
): Promise<Readonly<{ artifact_path: string; audit_path: string }>> {
  const artifactPath = resolveArtifactPath(configPaths, operation, now, outputPath);
  return await runArtifactOperation({
    operation,
    configPaths,
    now,
    artifactPath,
    execute: async () => {
      const bundle = await buildBundle(configPaths, operation, now);
      await writeJsonAtomic(artifactPath, bundle, 0o600);
      return { artifactPath, partialState: [artifactPath] };
    }
  });
}

function resolveArtifactPath(
  configPaths: AlayaConfigPaths,
  operation: "backup" | "export",
  now: () => string,
  outputPath: string | null | undefined
): string {
  return (
    normalizeOptionalPath(outputPath) ??
    path.join(configPaths.operationsDir, `${operation}-${toFilenameTimestamp(now())}.json`)
  );
}

async function previewBundleImport(bundlePath: string): Promise<ImportPreview> {
  const bundle = await readBundle(bundlePath);
  return {
    bundle_kind: bundle.kind,
    created_at: bundle.created_at,
    has_config_toml: bundle.config.alaya_toml !== null,
    has_env_file: bundle.config.env_file !== null,
    has_database_payload: bundle.storage.db_base64 !== null,
    db_path: bundle.storage.db_path
  };
}

async function importOperationsBundle(
  configPaths: AlayaConfigPaths,
  now: () => string,
  bundlePath: string
): Promise<Readonly<{ audit_path: string; restored_paths: readonly string[] }>> {
  const bundle = await readBundle(bundlePath);
  const audit = await startImportAudit(configPaths, now, bundlePath);
  const restoredPaths: string[] = [];
  try {
    await restoreImportedBundle(configPaths, bundle, restoredPaths);
    await finishImportAudit(audit, now, restoredPaths, null);
    return { audit_path: audit.auditPath, restored_paths: restoredPaths };
  } catch (error) {
    await finishImportAudit(audit, now, restoredPaths, error);
    throw error;
  }
}

async function startImportAudit(
  configPaths: AlayaConfigPaths,
  now: () => string,
  bundlePath: string
): Promise<Readonly<{ auditPath: string; startedAt: string; bundlePath: string }>> {
  const startedAt = now();
  const auditPath = buildOperationAuditPath(configPaths, "import", startedAt);
  await mkdir(configPaths.auditDir, { recursive: true, mode: 0o700 });
  await writeOperationAudit(auditPath, {
    operation: "import",
    status: "started",
    started_at: startedAt,
    finished_at: null,
    artifact_path: null,
    bundle_path: bundlePath,
    partial_state: [],
    error: null
  });
  return { auditPath, startedAt, bundlePath };
}

async function restoreImportedBundle(
  configPaths: AlayaConfigPaths,
  bundle: OperationsBundle,
  restoredPaths: string[]
): Promise<void> {
  const restoreDbPath = await resolveImportDbPath(configPaths, bundle);
  await restoreImportedConfigFiles(configPaths, bundle, restoreDbPath, restoredPaths);
  if (bundle.storage.db_base64 === null || restoreDbPath === null) {
    return;
  }
  const dbBytes = Buffer.from(bundle.storage.db_base64, "base64");
  await writeBufferAtomic(restoreDbPath, dbBytes, 0o600);
  restoredPaths.push(restoreDbPath);
}

async function resolveImportDbPath(
  configPaths: AlayaConfigPaths,
  bundle: OperationsBundle
): Promise<string | null> {
  if (bundle.storage.db_base64 === null) {
    return null;
  }
  return await resolveConfiguredDatabasePath(configPaths, {
    env: {},
    fallbackPath: path.join(configPaths.configDir, "alaya.db")
  });
}

async function restoreImportedConfigFiles(
  configPaths: AlayaConfigPaths,
  bundle: OperationsBundle,
  restoreDbPath: string | null,
  restoredPaths: string[]
): Promise<void> {
  if (bundle.config.alaya_toml !== null) {
    await writeTextAtomic(
      configPaths.tomlPath,
      restoreDbPath === null
        ? bundle.config.alaya_toml
        : replaceStorageDbPathInToml(bundle.config.alaya_toml, restoreDbPath),
      0o600
    );
    restoredPaths.push(configPaths.tomlPath);
  }
  if (bundle.config.env_file !== null) {
    await writeTextAtomic(configPaths.envPath, bundle.config.env_file, 0o600);
    restoredPaths.push(configPaths.envPath);
  }
}

async function finishImportAudit(
  audit: Readonly<{ auditPath: string; startedAt: string; bundlePath: string }>,
  now: () => string,
  restoredPaths: readonly string[],
  error: unknown
): Promise<void> {
  await writeOperationAudit(audit.auditPath, {
    operation: "import",
    status: error === null ? "succeeded" : "failed",
    started_at: audit.startedAt,
    finished_at: now(),
    artifact_path: null,
    bundle_path: audit.bundlePath,
    partial_state: restoredPaths,
    error: error === null ? null : toErrorMessage(error)
  });
}

async function runArtifactOperation(input: {
  readonly operation: "backup" | "export";
  readonly configPaths: AlayaConfigPaths;
  readonly now: () => string;
  readonly artifactPath: string;
  readonly execute: () => Promise<Readonly<{ artifactPath: string; partialState: readonly string[] }>>;
}): Promise<Readonly<{ artifact_path: string; audit_path: string }>> {
  const audit = await startArtifactOperationAudit(input);
  try {
    const result = await input.execute();
    await finishArtifactOperationAudit(input, audit, result);
    return { artifact_path: result.artifactPath, audit_path: audit.auditPath };
  } catch (error) {
    await failArtifactOperationAudit(input, audit, error);
    throw error;
  }
}

async function buildBundle(
  configPaths: AlayaConfigPaths,
  kind: "backup" | "export",
  now: () => string
): Promise<OperationsBundle> {
  const tomlContent = await readOptionalUtf8(configPaths.tomlPath);
  const envContent = await readOptionalUtf8(configPaths.envPath);
  const dbPath = tomlContent === null ? null : parseStorageDbPathFromToml(tomlContent);
  const dbBytes =
    dbPath === null ? null : await readOptionalBuffer(dbPath);

  return {
    bundle_version: 1,
    kind,
    created_at: now(),
    config: {
      alaya_toml: tomlContent,
      env_file: envContent
    },
    storage: {
      db_path: dbPath,
      db_base64: dbBytes === null ? null : dbBytes.toString("base64")
    }
  };
}

async function writeOperationAudit(
  auditPath: string,
  input: Omit<OperationAuditRecord, "audit_version">
): Promise<void> {
  const record: OperationAuditRecord = {
    audit_version: 1,
    ...input
  };
  await writeJsonAtomic(auditPath, record, 0o600);
}

async function startArtifactOperationAudit(input: {
  readonly operation: "backup" | "export";
  readonly configPaths: AlayaConfigPaths;
  readonly now: () => string;
  readonly artifactPath: string;
}): Promise<Readonly<{ startedAt: string; auditPath: string }>> {
  const startedAt = input.now();
  const auditPath = buildOperationAuditPath(input.configPaths, input.operation, startedAt);
  await mkdir(input.configPaths.auditDir, { recursive: true, mode: 0o700 });
  await writeOperationAudit(auditPath, {
    operation: input.operation,
    status: "started",
    started_at: startedAt,
    finished_at: null,
    artifact_path: input.artifactPath,
    bundle_path: null,
    partial_state: [],
    error: null
  });
  return { startedAt, auditPath };
}

async function finishArtifactOperationAudit(
  input: {
    readonly operation: "backup" | "export";
    readonly now: () => string;
  },
  audit: Readonly<{ startedAt: string; auditPath: string }>,
  result: Readonly<{ artifactPath: string; partialState: readonly string[] }>
): Promise<void> {
  await writeOperationAudit(audit.auditPath, {
    operation: input.operation,
    status: "succeeded",
    started_at: audit.startedAt,
    finished_at: input.now(),
    artifact_path: result.artifactPath,
    bundle_path: null,
    partial_state: result.partialState,
    error: null
  });
}

async function failArtifactOperationAudit(
  input: {
    readonly operation: "backup" | "export";
    readonly now: () => string;
    readonly artifactPath: string;
  },
  audit: Readonly<{ startedAt: string; auditPath: string }>,
  error: unknown
): Promise<void> {
  await writeOperationAudit(audit.auditPath, {
    operation: input.operation,
    status: "failed",
    started_at: audit.startedAt,
    finished_at: input.now(),
    artifact_path: input.artifactPath,
    bundle_path: null,
    partial_state: [],
    error: toErrorMessage(error)
  });
}

async function writeJsonAtomic(filePath: string, value: unknown, mode: number): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value)}\n`, mode);
}

async function writeBufferAtomic(filePath: string, content: Buffer, mode: number): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  const directory = path.dirname(normalizedPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.tmp-${path.basename(normalizedPath)}-${randomUUID()}`
  );
  await writeFile(tempPath, content, { mode });
  await rename(tempPath, normalizedPath);
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isFsCode(error, "ENOENT")) {
      return null;
    }
    throw new AlayaOperationError("NOINPUT", `Unable to read file: ${filePath}`);
  }
}

async function readOptionalBuffer(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isFsCode(error, "ENOENT")) {
      return null;
    }
    throw new AlayaOperationError("NOINPUT", `Unable to read file: ${filePath}`);
  }
}

function normalizeOptionalPath(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : path.resolve(trimmed);
}

function toFilenameTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:]/g, "-");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const trimmed = error.message.trim();
    return trimmed.length > 0 ? trimmed : "unknown_error";
  }
  return "unknown_error";
}

function isFsCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
