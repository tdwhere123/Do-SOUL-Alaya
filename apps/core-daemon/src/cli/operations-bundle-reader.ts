import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AlayaOperationError,
  type OperationsBundle
} from "./operations-types.js";

export async function readBundle(bundlePath: string): Promise<OperationsBundle> {
  const normalizedBundlePath = path.resolve(bundlePath);
  const rawText = await readBundleText(normalizedBundlePath);
  const parsed = parseBundleJson(rawText);
  const kind = parsed.kind;
  const createdAt = readBundleCreatedAt(parsed.created_at);
  const config = readBundleSection(parsed.config, "config");
  const storage = readBundleSection(parsed.storage, "storage");
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

async function readBundleText(bundlePath: string): Promise<string> {
  try {
    return await readFile(bundlePath, "utf8");
  } catch (error) {
    if (isFsCode(error, "ENOENT")) {
      throw new AlayaOperationError("NOINPUT", `Bundle file not found: ${bundlePath}`);
    }
    if (isFsCode(error, "EACCES") || isFsCode(error, "EPERM")) {
      throw new AlayaOperationError("NOPERM", `Permission denied reading bundle: ${bundlePath}`);
    }
    throw new AlayaOperationError("NOINPUT", `Unable to read bundle: ${bundlePath}`);
  }
}

function parseBundleJson(rawText: string): Record<string, unknown> & {
  readonly kind: "backup" | "export";
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    throw new AlayaOperationError("DATAERR", "Bundle JSON is malformed.");
  }
  if (!isObject(parsed)) {
    throw new AlayaOperationError("DATAERR", "Bundle root must be an object.");
  }
  if (parsed.bundle_version !== 1) {
    throw new AlayaOperationError("DATAERR", "Unsupported bundle_version.");
  }
  if (parsed.kind !== "backup" && parsed.kind !== "export") {
    throw new AlayaOperationError("DATAERR", "Bundle kind must be backup or export.");
  }
  return parsed as Record<string, unknown> & { readonly kind: "backup" | "export" };
}

function readBundleCreatedAt(value: unknown): string {
  const createdAt = typeof value === "string" ? value : "";
  if (createdAt.trim().length === 0) {
    throw new AlayaOperationError("DATAERR", "Bundle created_at must be a non-empty string.");
  }
  return createdAt;
}

function readBundleSection(value: unknown, field: "config" | "storage"): Record<string, unknown> {
  if (!isObject(value)) {
    throw new AlayaOperationError("DATAERR", `Bundle ${field} section must be an object.`);
  }
  return value;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFsCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
