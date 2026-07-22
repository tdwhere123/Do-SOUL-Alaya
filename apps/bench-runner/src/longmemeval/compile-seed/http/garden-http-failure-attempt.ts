import { createHash } from "node:crypto";
import type {
  BenchTransportFailureAttempt,
  BenchTransportFailureKind,
  BenchTransportFailurePhase
} from "../compile-seed-types.js";

interface SafeFailureFingerprintInput {
  readonly kind: BenchTransportFailureKind;
  readonly phase: BenchTransportFailurePhase;
  readonly httpStatus: number | null;
  readonly errorName: string | null;
  readonly errorCode: string | null;
  readonly providerCode: string | null;
  readonly providerType: string | null;
  readonly rawBodyDigest: string | null;
}

const FAILURE_INPUT = Symbol("gardenHttpFailureFingerprintInput");
const MAX_FINGERPRINT_TOKEN_LENGTH = 128;
const MAX_RAW_BODY_FINGERPRINT_BYTES = 16_384;

export function markGardenHttpFailure(
  cause: unknown,
  descriptor: Readonly<{
    kind: BenchTransportFailureKind;
    phase: BenchTransportFailurePhase;
    httpStatus?: number | null;
    rawBody?: string;
  }>
): Error {
  const error = cause instanceof Error ? cause : new Error("garden HTTP transport failed");
  if (readSafeFailureInput(error) !== undefined) return error;
  const provider = descriptor.rawBody === undefined
    ? { code: null, type: null }
    : readProviderErrorIdentity(descriptor.rawBody);
  const input: SafeFailureFingerprintInput = Object.freeze({
    kind: descriptor.kind,
    phase: descriptor.phase,
    httpStatus: normalizeHttpStatus(descriptor.httpStatus),
    errorName: safeToken(error.name),
    errorCode: readErrorCode(error),
    providerCode: provider.code,
    providerType: provider.type,
    rawBodyDigest: descriptor.rawBody === undefined || provider.code !== null || provider.type !== null
      ? null
      : digestBoundedRawBody(descriptor.rawBody)
  });
  Object.defineProperty(error, FAILURE_INPUT, { value: input, configurable: true });
  return error;
}

export function overrideGardenHttpFailureKind(
  cause: unknown,
  kind: "timeout" | "aborted"
): Error {
  const error = cause instanceof Error ? cause : new Error("garden HTTP transport failed");
  const prior = readSafeFailureInput(error);
  const input: SafeFailureFingerprintInput = Object.freeze({
    kind,
    phase: prior?.phase ?? "request",
    httpStatus: prior?.httpStatus ?? null,
    errorName: prior?.errorName ?? safeToken(error.name),
    errorCode: prior?.errorCode ?? readErrorCode(error),
    providerCode: prior?.providerCode ?? null,
    providerType: prior?.providerType ?? null,
    rawBodyDigest: prior?.rawBodyDigest ?? null
  });
  Object.defineProperty(error, FAILURE_INPUT, { value: input, configurable: true });
  return error;
}

export function toBenchTransportFailureAttempt(
  error: unknown,
  zeroBasedAttempt: number
): BenchTransportFailureAttempt | undefined {
  const input = readSafeFailureInput(error);
  if (input === undefined) return undefined;
  return Object.freeze({
    kind: input.kind,
    phase: input.phase,
    httpStatus: input.httpStatus,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(input), "utf8")
      .digest("hex"),
    attempt: zeroBasedAttempt + 1
  });
}

export function classifyResponseFailureKind(
  error: unknown
): "response_parse_error" | "response_schema_error" {
  return error instanceof Error && /schema validation/i.test(error.message)
    ? "response_schema_error"
    : "response_parse_error";
}

export function settleGardenHttpAttemptFailure(
  cause: unknown,
  timedOut: boolean,
  aborted: boolean
): Error {
  const error = cause instanceof Error ? cause : new Error("garden HTTP transport failed");
  const statusAlreadyFailed = readSafeFailureInput(error)?.kind === "http_error";
  const effectiveTimeout = timedOut && !statusAlreadyFailed;
  (error as { benchAttemptTimedOut?: boolean }).benchAttemptTimedOut = effectiveTimeout;
  if (effectiveTimeout) return overrideGardenHttpFailureKind(error, "timeout");
  if (aborted) return overrideGardenHttpFailureKind(error, "aborted");
  return error;
}

export function readGardenHttpAttemptTimedOut(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { readonly benchAttemptTimedOut?: unknown }).benchAttemptTimedOut === true;
}

function readSafeFailureInput(error: unknown): SafeFailureFingerprintInput | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { readonly [FAILURE_INPUT]?: SafeFailureFingerprintInput })[FAILURE_INPUT];
}

function normalizeHttpStatus(value: number | null | undefined): number | null {
  return Number.isInteger(value) && value !== undefined && value !== null &&
    value >= 100 && value <= 599 ? value : null;
}

function readErrorCode(error: Error): string | null {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? safeToken(String(code)) : null;
}

function safeToken(value: string): string | null {
  return /^[A-Za-z0-9_.:-]+$/.test(value) && value.length <= MAX_FINGERPRINT_TOKEN_LENGTH
    ? value
    : null;
}

function readProviderErrorIdentity(rawBody: string): { code: string | null; type: string | null } {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { code: null, type: null };
    const nested = (parsed as { readonly error?: unknown }).error;
    const error = typeof nested === "object" && nested !== null ? nested : parsed;
    return {
      code: readIdentityField(error, "code"),
      type: readIdentityField(error, "type")
    };
  } catch {
    return { code: null, type: null };
  }
}

function readIdentityField(value: object, key: "code" | "type"): string | null {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" || typeof candidate === "number"
    ? safeToken(String(candidate))
    : null;
}

function digestBoundedRawBody(rawBody: string): string {
  const bounded = Buffer.from(rawBody, "utf8").subarray(0, MAX_RAW_BODY_FINGERPRINT_BYTES);
  return createHash("sha256").update(bounded).digest("hex");
}
