import { CoreError } from "@do-soul/alaya-core";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnv(content: string | null): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of (content ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    entries.set(key, parseEnvValue(rawValue));
  }
  return entries;
}

export function renderEnv(entries: ReadonlyMap<string, string>): string {
  return `${Array.from(entries.entries()).map(([key, value]) => `${renderEnvKey(key)}=${renderEnvValue(value)}`).join("\n")}\n`;
}

function parseEnvValue(rawValue: string): string {
  if (rawValue.startsWith("\"")) {
    if (!rawValue.endsWith("\"") || rawValue.length === 1) {
      throw new CoreError("VALIDATION", "Invalid quoted .env value");
    }
    return rawValue.slice(1, -1).replace(/\\(["\\])/gu, "$1");
  }
  return rawValue;
}

function renderEnvKey(key: string): string {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new CoreError("VALIDATION", `Invalid .env key: ${key}`);
  }
  return key;
}

function renderEnvValue(value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new CoreError("VALIDATION", ".env values must be single-line");
  }
  if (value.includes("#")) {
    return `"${value.replace(/["\\]/gu, "\\$&")}"`;
  }
  return value;
}
