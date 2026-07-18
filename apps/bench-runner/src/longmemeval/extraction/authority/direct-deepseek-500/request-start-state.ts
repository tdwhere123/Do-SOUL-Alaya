import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DirectDeepSeek500SpendAuthorization } from "../direct-deepseek-500.js";

const REQUEST_START_STATE_VERSION = 1;
const requestStartStateFilename = ".alaya-direct-deepseek-500-request-start-state.json";

interface StoredRequestStartState {
  readonly schema_version: typeof REQUEST_START_STATE_VERSION;
  readonly cache_root_marker_sha256: string;
  readonly requests_per_minute: number;
  readonly last_request_start_at_ms: number;
}

export interface RequestStartState {
  readonly readLastStartAt: () => number | undefined;
  readonly recordStartAt: (startedAt: number) => void;
}

export function openDirectDeepSeekRequestStartState(input: {
  readonly cacheRoot: string;
  readonly authorization: DirectDeepSeek500SpendAuthorization;
}): RequestStartState {
  const path = join(input.cacheRoot, requestStartStateFilename);
  const identity = {
    cacheRootMarkerSha256: input.authorization.cache_root_marker_sha256,
    requestsPerMinute: input.authorization.requests_per_minute
  };
  return Object.freeze({
    readLastStartAt: () => readLastStartAt(path, identity),
    recordStartAt: (startedAt: number) => writeLastStartAt(path, identity, startedAt)
  });
}

function readLastStartAt(
  path: string,
  identity: { readonly cacheRootMarkerSha256: string; readonly requestsPerMinute: number }
): number | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error("direct DeepSeek request start state is unreadable", { cause });
  }
  assertStoredState(parsed, identity);
  return parsed.last_request_start_at_ms;
}

function writeLastStartAt(
  path: string,
  identity: { readonly cacheRootMarkerSha256: string; readonly requestsPerMinute: number },
  startedAt: number
): void {
  if (!isTimestamp(startedAt)) throw new Error("direct DeepSeek request start time is invalid");
  const state: StoredRequestStartState = {
    schema_version: REQUEST_START_STATE_VERSION,
    cache_root_marker_sha256: identity.cacheRootMarkerSha256,
    requests_per_minute: identity.requestsPerMinute,
    last_request_start_at_ms: startedAt
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function assertStoredState(
  value: unknown,
  identity: { readonly cacheRootMarkerSha256: string; readonly requestsPerMinute: number }
): asserts value is StoredRequestStartState {
  if (typeof value !== "object" || value === null) {
    throw new Error("direct DeepSeek request start state is invalid");
  }
  const state = value as Partial<StoredRequestStartState>;
  if (state.schema_version !== REQUEST_START_STATE_VERSION ||
      state.cache_root_marker_sha256 !== identity.cacheRootMarkerSha256 ||
      state.requests_per_minute !== identity.requestsPerMinute ||
      !isTimestamp(state.last_request_start_at_ms)) {
    throw new Error("direct DeepSeek request start state is bound to another root or rate limit");
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
