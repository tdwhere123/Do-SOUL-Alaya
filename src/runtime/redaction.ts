import type { JsonObject, JsonValue } from "./json.js";

const secretKeyPattern = /(secret|token|password|credential|authorization|api[_-]?key)/i;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const openAiStyleKeyPattern = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const assignmentPattern = /\b(password|token|secret|authorization|api[_-]?key)\s*([:=])\s*([^&\s,;]+)/gi;
const spacedSecretPattern = /\b(password|token|secret|authorization|api[_-]?key)\s+([^&\s,;]+)/gi;
const cliAssignmentPattern = /--(password|token|secret|authorization|api[-_]?key)=([^&\s]+)/gi;
const cliSpacedSecretPattern = /--(password|token|secret|authorization|api[-_]?key)\s+([^&\s]+)/gi;

export function redactString(value: string): string {
  return value
    .replace(bearerPattern, "Bearer [REDACTED]")
    .replace(openAiStyleKeyPattern, "sk-[REDACTED]")
    .replace(cliAssignmentPattern, "--$1=[REDACTED]")
    .replace(cliSpacedSecretPattern, "--$1 [REDACTED]")
    .replace(assignmentPattern, (match, key: string, separator: string, value: string) => {
      if (key.toLowerCase() === "authorization" && value.toLowerCase() === "bearer") {
        return match;
      }
      return `${key}${separator}${separator === "=" ? "" : " "}[REDACTED]`;
    })
    .replace(spacedSecretPattern, "$1 [REDACTED]");
}

export function redactJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry));
  }
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = secretKeyPattern.test(key) ? "[REDACTED]" : redactJsonValue(child);
    }
    return output;
  }
  return String(value);
}

export function redactJsonObject(value: unknown): JsonObject {
  const redacted = redactJsonValue(value);
  return typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
    ? redacted
    : { value: redacted };
}

export function errorToRedactedJson(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactString(error.message)
    };
  }
  return {
    name: "NonError",
    message: redactString(String(error))
  };
}
