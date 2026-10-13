import { ExtractionFillTaskError } from "../../runs/extraction/fill/fill-pool.js";

const MAX_DEPTH = 4;
const MAX_NODES = 12;
const MAX_MEMBERS = 4;
const MAX_MESSAGE_LENGTH = 512;
const MAX_DIAGNOSTIC_LENGTH = 4_096;
const TRUNCATED = "[truncated]";

/** Fill failures retain ordered cleanup causes without printing provider task payloads. */
export function formatFillFailure(error: unknown): string {
  const seen = new Set<Error>();
  const parts: string[] = [];
  const pending: Array<{ value: unknown; path: string; depth: number; truncated?: true }> = [
    { value: error, path: "", depth: 0 }
  ];
  while (pending.length > 0 && parts.length < MAX_NODES) {
    // Direct task/release siblings must be visible before either one's deeper causes.
    const node = pending.shift()!;
    if (node.truncated) {
      parts.push(TRUNCATED);
      continue;
    }
    const value = node.value;
    const label = node.path === "" ? "" : `${node.path}=`;
    if (!(value instanceof Error)) {
      parts.push(`${label}${nonErrorName(value)}`);
      continue;
    }
    if (seen.has(value)) {
      parts.push(`${label}[already reported]`);
      continue;
    }
    seen.add(value);
    const message = `${label}${label === "" ? "" : `${errorName(value)}: `}${safeMessage(value.message)}`;
    // Task causes can contain credentials and prompt text; their name is the public summary.
    if (value instanceof ExtractionFillTaskError) {
      parts.push(`${message} cause=${value.cause instanceof Error ? errorName(value.cause) : "non_error"}`);
      continue;
    }
    parts.push(message);
    const members = value instanceof AggregateError && Array.isArray(value.errors) ? value.errors : [];
    if (node.depth >= MAX_DEPTH) {
      if (members.length > 0 || value.cause !== undefined) parts.push(TRUNCATED);
      continue;
    }
    const prefix = node.path === "" ? "" : `${node.path}.`;
    for (let index = 0; index < Math.min(members.length, MAX_MEMBERS); index += 1) {
      pending.push({ value: members[index], path: `${prefix}errors[${index}]`, depth: node.depth + 1 });
    }
    if (value.cause !== undefined) pending.push({ value: value.cause, path: `${prefix}cause`, depth: node.depth + 1 });
    if (members.length > MAX_MEMBERS) pending.push({ value: undefined, path: "", depth: node.depth + 1, truncated: true });
  }
  if (pending.length > 0) parts.push(TRUNCATED);
  return bounded(parts.join(" | "), MAX_DIAGNOSTIC_LENGTH);
}

function nonErrorName(value: unknown): string {
  return value === null ? "non_error_null" : `non_error_${typeof value}`;
}

function errorName(error: Error): string {
  return typeof error.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name) &&
    safeMessage(error.name) === error.name
    ? error.name : "Error";
}

function safeMessage(message: string): string {
  const redacted = message.slice(0, MAX_DIAGNOSTIC_LENGTH)
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-url]")
    .replace(/\b(?:proxy-)?authorization["']?\s*[:=]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\r\n;]+)/giu,
      "authorization=[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, "[redacted-authorization]")
    .replace(/\b(?:authorization|password|secret|token|api[_-]?key|client[_-]?secret|refresh[_-]?token)["']?\s*[:=]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/giu,
      "credential=[redacted]")
    .replace(/\b(?:sk-|gsk_|ghp_|github_pat_)[A-Za-z0-9_-]+/gu, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ");
  return bounded(redacted, MAX_MESSAGE_LENGTH);
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`;
}
