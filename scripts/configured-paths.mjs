// Shared by the built daemon and pre-install scripts; keep dependency-free.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function resolveAlayaConfigDir(environment, platform = process.platform, homeDir) {
  const overrideDir = trimEnv(environment.ALAYA_CONFIG_DIR);
  if (overrideDir !== null) {
    return path.resolve(overrideDir);
  }

  if (platform === "win32") {
    const appData = trimEnv(environment.APPDATA);
    if (appData !== null) {
      return path.resolve(appData, "alaya");
    }
    return path.resolve(resolveHomeDirectory(environment, homeDir), "AppData", "Roaming", "alaya");
  }

  const xdgConfigHome = trimEnv(environment.XDG_CONFIG_HOME);
  if (xdgConfigHome !== null) {
    return path.resolve(xdgConfigHome, "alaya");
  }

  return path.resolve(resolveHomeDirectory(environment, homeDir), ".config", "alaya");
}

export function resolveConfiguredDatabasePath(tomlPath, environment, fallbackPath, launchCwd = process.cwd()) {
  const fromToml = readStorageDbPathFromToml(tomlPath);
  if (fromToml !== null) {
    return path.resolve(launchCwd, fromToml);
  }

  const dataDir = trimEnv(environment.DATA_DIR);
  if (dataDir !== null) {
    return path.join(path.resolve(launchCwd, dataDir), "alaya.db");
  }

  return path.resolve(launchCwd, fallbackPath);
}

function readStorageDbPathFromToml(tomlPath) {
  try {
    return parseStorageDbPathFromToml(readFileSync(tomlPath, "utf8"));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export function parseStorageDbPathFromToml(tomlContent) {
  const lines = tomlContent.split(/\r?\n/u);
  let section = null;
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

function parseTomlStringLiteral(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) {
    return null;
  }
  return trimmed.slice(1, -1).replaceAll("\\\\", "\\").replaceAll("\\\"", "\"").replaceAll("\\n", "\n");
}

function resolveHomeDirectory(environment, homeDir) {
  const home = environment.HOME?.trim() ?? homeDir ?? homedir();
  return home.length > 0 ? home : homedir();
}

function trimEnv(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isNodeErrorWithCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
