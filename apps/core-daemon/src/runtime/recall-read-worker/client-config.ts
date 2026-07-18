import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RecallReadWorkerOperation, RecallReadWorkerResponse } from "./protocol.js";
import { parseNodeTimerDelayMs } from "../timing/node-timer-delay.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_COUNT = 2;
const MAX_WORKER_COUNT = 4;
const REQUEST_TIMEOUT_ENV = "ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS";

export function normalizeRequestTimeoutMs(value: number | undefined): number {
  const configuredEnv = process.env[REQUEST_TIMEOUT_ENV]?.trim();
  if (value === undefined && (configuredEnv === undefined || configuredEnv.length === 0)) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return parseNodeTimerDelayMs(
    value ?? Number(configuredEnv),
    "recall read worker request timeout"
  );
}

export function normalizeWorkerCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WORKER_COUNT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKER_COUNT) {
    throw new Error(`recall read worker count must be an integer between 1 and ${MAX_WORKER_COUNT}`);
  }
  return value;
}

export function isPathAffinityOperation(operation: RecallReadWorkerOperation): boolean {
  return operation.startsWith("path") || operation === "constraints.findActive";
}

export function resolveDefaultWorkerUrl(): URL | null {
  const sibling = new URL("../recall-read-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return sibling;

  const builtFromSource = new URL("../../../dist/runtime/recall-read-worker.js", import.meta.url);
  return existsSync(fileURLToPath(builtFromSource)) ? builtFromSource : null;
}

export function isRecallReadWorkerResponse(value: unknown): value is RecallReadWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { readonly id?: unknown; readonly ok?: unknown };
  return typeof record.id === "number" && typeof record.ok === "boolean";
}
