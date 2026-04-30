import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildOperationAuditPath,
  type AlayaConfigPaths
} from "./cli/config-files.js";

export type OperationName = "backup" | "export" | "import";

export interface OperationAuditRecord {
  readonly operation: OperationName;
  readonly status: "started" | "succeeded" | "failed";
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly audit_version: 1;
  readonly artifact_path: string | null;
  readonly bundle_path: string | null;
  readonly partial_state: readonly string[];
  readonly error: string | null;
}

export interface OperationsBundle {
  readonly bundle_version: 1;
  readonly kind: "backup" | "export";
  readonly created_at: string;
  readonly config: Readonly<{
    alaya_toml: string | null;
    env_file: string | null;
  }>;
  readonly storage: Readonly<{
    db_path: string | null;
    db_base64: string | null;
  }>;
}

export interface ImportPreview {
  readonly bundle_kind: OperationsBundle["kind"];
  readonly created_at: string;
  readonly has_config_toml: boolean;
  readonly has_env_file: boolean;
  readonly has_database_payload: boolean;
  readonly db_path: string | null;
}

export interface AlayaOperationsService {
  backup(input?: { readonly outputPath?: string | null }): Promise<Readonly<{ artifact_path: string; audit_path: string }>>;
  exportBundle(input?: { readonly outputPath?: string | null }): Promise<Readonly<{ artifact_path: string; audit_path: string }>>;
  previewImport(input: { readonly bundlePath: string }): Promise<ImportPreview>;
  importBundle(input: { readonly bundlePath: string }): Promise<Readonly<{ audit_path: string; restored_paths: readonly string[] }>>;
}

export interface AlayaOperationsServiceDependencies {
  readonly configPaths: AlayaConfigPaths;
  readonly clock?: () => string;
}

export class AlayaOperationError extends Error {
  public constructor(
    public readonly code: "DATAERR" | "NOINPUT" | "CANTCREAT" | "NOPERM",
    message: string
  ) {
    super(message);
    this.name = "AlayaOperationError";
  }
}

export function createAlayaOperationsService(
  deps: AlayaOperationsServiceDependencies
): AlayaOperationsService {
  const now = deps.clock ?? (() => new Date().toISOString());

  return {
    backup: async (input = {}) => {
      const artifactPath =
        normalizeOptionalPath(input.outputPath) ??
        path.join(
          deps.configPaths.operationsDir,
          `backup-${toFilenameTimestamp(now())}.json`
        );
      return await runArtifactOperation({
        operation: "backup",
        configPaths: deps.configPaths,
        now,
        artifactPath,
        execute: async () => {
          const bundle = await buildBundle(deps.configPaths, "backup", now);
          await writeJsonAtomic(artifactPath, bundle, 0o600);
          return { artifactPath, partialState: [artifactPath] };
        }
      });
    },

    exportBundle: async (input = {}) => {
      const artifactPath =
        normalizeOptionalPath(input.outputPath) ??
        path.join(
          deps.configPaths.operationsDir,
          `export-${toFilenameTimestamp(now())}.json`
        );
      return await runArtifactOperation({
        operation: "export",
        configPaths: deps.configPaths,
        now,
        artifactPath,
        execute: async () => {
          const bundle = await buildBundle(deps.configPaths, "export", now);
          await writeJsonAtomic(artifactPath, bundle, 0o600);
          return { artifactPath, partialState: [artifactPath] };
        }
      });
    },

    previewImport: async ({ bundlePath }) => {
      const bundle = await readBundle(bundlePath);
      return {
        bundle_kind: bundle.kind,
        created_at: bundle.created_at,
        has_config_toml: bundle.config.alaya_toml !== null,
        has_env_file: bundle.config.env_file !== null,
        has_database_payload: bundle.storage.db_base64 !== null,
        db_path: bundle.storage.db_path
      };
    },

    importBundle: async ({ bundlePath }) => {
      const bundle = await readBundle(bundlePath);
      const startedAt = now();
      const auditPath = buildOperationAuditPath(
        deps.configPaths,
        "import",
        startedAt
      );
      await mkdir(deps.configPaths.auditDir, { recursive: true, mode: 0o700 });
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

      const restoredPaths: string[] = [];
      try {
        if (bundle.config.alaya_toml !== null) {
          await writeTextAtomic(deps.configPaths.tomlPath, bundle.config.alaya_toml, 0o600);
          restoredPaths.push(deps.configPaths.tomlPath);
        }
        if (bundle.config.env_file !== null) {
          await writeTextAtomic(deps.configPaths.envPath, bundle.config.env_file, 0o600);
          restoredPaths.push(deps.configPaths.envPath);
        }

        if (bundle.storage.db_base64 !== null) {
          const dbPath = bundle.storage.db_path;
          if (!dbPath) {
            throw new AlayaOperationError("DATAERR", "Bundle contains DB payload but no db_path.");
          }
          const dbBytes = Buffer.from(bundle.storage.db_base64, "base64");
          await writeBufferAtomic(dbPath, dbBytes, 0o600);
          restoredPaths.push(dbPath);
        }

        await writeOperationAudit(auditPath, {
          operation: "import",
          status: "succeeded",
          started_at: startedAt,
          finished_at: now(),
          artifact_path: null,
          bundle_path: bundlePath,
          partial_state: restoredPaths,
          error: null
        });
        return {
          audit_path: auditPath,
          restored_paths: restoredPaths
        };
      } catch (error) {
        await writeOperationAudit(auditPath, {
          operation: "import",
          status: "failed",
          started_at: startedAt,
          finished_at: now(),
          artifact_path: null,
          bundle_path: bundlePath,
          partial_state: restoredPaths,
          error: toErrorMessage(error)
        });
        throw error;
      }
    }
  };
}

async function runArtifactOperation(input: {
  readonly operation: "backup" | "export";
  readonly configPaths: AlayaConfigPaths;
  readonly now: () => string;
  readonly artifactPath: string;
  readonly execute: () => Promise<Readonly<{ artifactPath: string; partialState: readonly string[] }>>;
}): Promise<Readonly<{ artifact_path: string; audit_path: string }>> {
  const startedAt = input.now();
  const auditPath = buildOperationAuditPath(
    input.configPaths,
    input.operation,
    startedAt
  );
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

  try {
    const result = await input.execute();
    await writeOperationAudit(auditPath, {
      operation: input.operation,
      status: "succeeded",
      started_at: startedAt,
      finished_at: input.now(),
      artifact_path: result.artifactPath,
      bundle_path: null,
      partial_state: result.partialState,
      error: null
    });
    return {
      artifact_path: result.artifactPath,
      audit_path: auditPath
    };
  } catch (error) {
    await writeOperationAudit(auditPath, {
      operation: input.operation,
      status: "failed",
      started_at: startedAt,
      finished_at: input.now(),
      artifact_path: input.artifactPath,
      bundle_path: null,
      partial_state: [],
      error: toErrorMessage(error)
    });
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
  const dbPath = tomlContent === null ? null : parseDbPathFromToml(tomlContent);
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

async function readBundle(bundlePath: string): Promise<OperationsBundle> {
  const normalizedBundlePath = path.resolve(bundlePath);
  let rawText: string;
  try {
    rawText = await readFile(normalizedBundlePath, "utf8");
  } catch (error) {
    if (isFsCode(error, "ENOENT")) {
      throw new AlayaOperationError("NOINPUT", `Bundle file not found: ${normalizedBundlePath}`);
    }
    if (isFsCode(error, "EACCES") || isFsCode(error, "EPERM")) {
      throw new AlayaOperationError("NOPERM", `Permission denied reading bundle: ${normalizedBundlePath}`);
    }
    throw new AlayaOperationError("NOINPUT", `Unable to read bundle: ${normalizedBundlePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    throw new AlayaOperationError("DATAERR", "Bundle JSON is malformed.");
  }

  if (!isObject(parsed)) {
    throw new AlayaOperationError("DATAERR", "Bundle root must be an object.");
  }

  const version = parsed.bundle_version;
  if (version !== 1) {
    throw new AlayaOperationError("DATAERR", "Unsupported bundle_version.");
  }

  const kind = parsed.kind;
  if (kind !== "backup" && kind !== "export") {
    throw new AlayaOperationError("DATAERR", "Bundle kind must be backup or export.");
  }

  const createdAt = typeof parsed.created_at === "string" ? parsed.created_at : "";
  if (createdAt.trim().length === 0) {
    throw new AlayaOperationError("DATAERR", "Bundle created_at must be a non-empty string.");
  }

  const config = parsed.config;
  const storage = parsed.storage;
  if (!isObject(config) || !isObject(storage)) {
    throw new AlayaOperationError("DATAERR", "Bundle config/storage sections must be objects.");
  }

  const alayaToml = nullableString(config.alaya_toml, "config.alaya_toml");
  const envFile = nullableString(config.env_file, "config.env_file");
  const dbPath = nullableString(storage.db_path, "storage.db_path");
  const dbBase64 = nullableString(storage.db_base64, "storage.db_base64");

  if (dbBase64 !== null && dbPath === null) {
    throw new AlayaOperationError("DATAERR", "storage.db_base64 requires storage.db_path.");
  }

  return {
    bundle_version: 1,
    kind,
    created_at: createdAt,
    config: {
      alaya_toml: alayaToml,
      env_file: envFile
    },
    storage: {
      db_path: dbPath,
      db_base64: dbBase64
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

async function writeJsonAtomic(filePath: string, value: unknown, mode: number): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value)}\n`, mode);
}

async function writeTextAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  const directory = path.dirname(normalizedPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.tmp-${path.basename(normalizedPath)}-${randomUUID()}`
  );
  await writeFile(tempPath, content, { encoding: "utf8", mode });
  await rename(tempPath, normalizedPath);
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

function parseDbPathFromToml(tomlContent: string): string | null {
  const lines = tomlContent.split(/\r?\n/u);
  let section: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[(.+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1]?.trim() ?? null;
      continue;
    }

    if (section !== "storage") {
      continue;
    }

    const kvMatch = line.match(/^db_path\s*=\s*(.+)$/u);
    if (!kvMatch || kvMatch[1] === undefined) {
      continue;
    }
    return parseTomlStringLiteral(kvMatch[1]);
  }
  return null;
}

function parseTomlStringLiteral(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) {
    return null;
  }
  const body = trimmed.slice(1, -1);
  return body
    .replaceAll("\\\\", "\\")
    .replaceAll("\\\"", "\"")
    .replaceAll("\\n", "\n");
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new AlayaOperationError("DATAERR", `${field} must be string or null.`);
  }
  return value;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFsCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
