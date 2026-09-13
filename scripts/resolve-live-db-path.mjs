#!/usr/bin/env node
// Installer locator for the live alaya.db. Mirrors resolveAlayaConfigDir +
// parseStorageDbPathFromToml, but relative toml/DATA_DIR paths resolve against
// the config dir so a cd into staging cannot retarget the snapshot.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const env = process.env;
const configDir = resolveAlayaConfigDir(env);
const dbPath = resolveLiveDatabasePath(configDir, env);
process.stdout.write(`${configDir}\t${dbPath}\n`);

function resolveAlayaConfigDir(environment) {
  const overrideDir = trimEnv(environment.ALAYA_CONFIG_DIR);
  if (overrideDir !== null) {
    return path.resolve(overrideDir);
  }

  if (process.platform === "win32") {
    const appData = trimEnv(environment.APPDATA);
    if (appData !== null) {
      return path.resolve(appData, "alaya");
    }
    return path.resolve(resolveHomeDirectory(environment), "AppData", "Roaming", "alaya");
  }

  const xdgConfigHome = trimEnv(environment.XDG_CONFIG_HOME);
  if (xdgConfigHome !== null) {
    return path.resolve(xdgConfigHome, "alaya");
  }

  return path.resolve(resolveHomeDirectory(environment), ".config", "alaya");
}

function resolveLiveDatabasePath(resolvedConfigDir, environment) {
  const fromToml = readStorageDbPathFromToml(path.join(resolvedConfigDir, "alaya.toml"));
  if (fromToml !== null) {
    return resolveAgainstConfigDir(resolvedConfigDir, fromToml);
  }

  const dataDir = trimEnv(environment.DATA_DIR);
  if (dataDir !== null) {
    return path.join(resolveAgainstConfigDir(resolvedConfigDir, dataDir), "alaya.db");
  }

  return path.join(resolvedConfigDir, "alaya.db");
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

function parseStorageDbPathFromToml(tomlContent) {
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

function resolveAgainstConfigDir(resolvedConfigDir, maybeRelative) {
  return path.isAbsolute(maybeRelative)
    ? path.normalize(maybeRelative)
    : path.resolve(resolvedConfigDir, maybeRelative);
}

function resolveHomeDirectory(environment) {
  const home = trimEnv(environment.HOME) ?? homedir();
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
