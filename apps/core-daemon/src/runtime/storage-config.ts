import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AlayaConfigPaths } from "../cli/config-files.js";

export interface ResolveConfiguredDatabasePathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackPath: string;
}

export async function resolveConfiguredDatabasePath(
  configPaths: AlayaConfigPaths,
  options: ResolveConfiguredDatabasePathOptions
): Promise<string> {
  const configuredPath = await readStorageDbPathFromToml(configPaths.tomlPath);
  if (configuredPath !== null) {
    return path.resolve(configuredPath);
  }

  const dataDir = options.env?.DATA_DIR?.trim();
  if (dataDir !== undefined && dataDir.length > 0) {
    return path.join(path.resolve(dataDir), "alaya.db");
  }

  return path.resolve(options.fallbackPath);
}

export async function readStorageDbPathFromToml(tomlPath: string): Promise<string | null> {
  try {
    return parseStorageDbPathFromToml(await readFile(tomlPath, "utf8"));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export function parseStorageDbPathFromToml(tomlContent: string): string | null {
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

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
