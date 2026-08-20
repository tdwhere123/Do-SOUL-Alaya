import { createHash } from "node:crypto";
import {
  ProviderChatCompletionError,
  providerFailureIdentityFromBody,
  safeProviderIdentityToken,
  type ProviderFailureIdentity,
  type ProviderTransportFailureKind
} from "@do-soul/alaya-engine-gateway";
import type {
  BenchProviderUsage,
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
const FAILURE_USAGE = Symbol("gardenHttpFailureUsage");

const PROVIDER_FAILURE_PHASE: Record<ProviderTransportFailureKind, BenchTransportFailurePhase> = {
  network_error: "request",
  http_error: "response_status",
  body_read_error: "response_body",
  response_parse_error: "response_parse",
  timeout: "request",
  aborted: "request"
};

export function markGardenHttpFailure(
  cause: unknown,
  descriptor: Readonly<{
    kind: BenchTransportFailureKind;
    phase: BenchTransportFailurePhase;
    httpStatus?: number | null;
    identity?: ProviderFailureIdentity;
    rawBody?: string;
    usage?: BenchProviderUsage;
  }>
): Error {
  const error = cause instanceof Error ? cause : new Error("garden HTTP transport failed");
  if (readSafeFailureInput(error) !== undefined) return error;
  return writeFailureInput(error, {
    kind: descriptor.kind,
    phase: descriptor.phase,
    httpStatus: normalizeHttpStatus(descriptor.httpStatus),
    ...resolveFailureIdentity(error, descriptor)
  }, descriptor.usage);
}

export function mapGardenHttpAttemptFailure(
  error: unknown,
  knownStatus: number | null,
  outcome: { readonly timedOut: boolean; readonly aborted: boolean }
): Error {
  const wrapped = error instanceof Error ? error : new Error("garden HTTP transport failed");
  if (outcome.timedOut) return finalizeTimeoutOrAbort(wrapped, "timeout", knownStatus, true);
  if (outcome.aborted) return finalizeTimeoutOrAbort(wrapped, "aborted", knownStatus, false);
  return mapNonTimeoutFailure(wrapped);
}

export function toBenchTransportFailureAttempt(
  error: unknown,
  zeroBasedAttempt: number
): BenchTransportFailureAttempt | undefined {
  const input = readSafeFailureInput(error);
  if (input === undefined) return undefined;
  const usage = readGardenHttpFailureUsage(error);
  return Object.freeze({
    kind: input.kind,
    phase: input.phase,
    httpStatus: input.httpStatus,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(input), "utf8")
      .digest("hex"),
    attempt: zeroBasedAttempt + 1,
    ...(usage === undefined ? {} : { usage })
  });
}

export function aggregateGardenHttpAttemptUsage(
  failures: readonly BenchTransportFailureAttempt[],
  successfulUsage?: BenchProviderUsage
): { readonly usage?: BenchProviderUsage; readonly usageRequestCount: number } {
  const usages = failures.flatMap((failure) => failure.usage === undefined ? [] : [failure.usage]);
  if (successfulUsage !== undefined) usages.push(successfulUsage);
  if (usages.length === 0) return { usageRequestCount: 0 };
  return {
    usageRequestCount: usages.length,
    usage: usages.reduce<BenchProviderUsage>((total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  };
}

export function readGardenHttpAttemptTimedOut(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { readonly benchAttemptTimedOut?: unknown }).benchAttemptTimedOut === true;
}

export function readGardenHttpFailureKind(
  error: unknown
): BenchTransportFailureKind | undefined {
  return readSafeFailureInput(error)?.kind;
}

export function readGardenHttpFailureHttpStatus(error: unknown): number | null {
  return readSafeFailureInput(error)?.httpStatus ?? null;
}

function mapNonTimeoutFailure(error: Error): Error {
  (error as { benchAttemptTimedOut?: boolean }).benchAttemptTimedOut = false;
  if (readSafeFailureInput(error) !== undefined) return error;
  if (error instanceof ProviderChatCompletionError) {
    return markGardenHttpFailure(error, descriptorForProviderFailure(error));
  }
  return error;
}

function finalizeTimeoutOrAbort(
  error: Error,
  kind: "timeout" | "aborted",
  knownStatus: number | null,
  timedOut: boolean
): Error {
  const prior = readSafeFailureInput(error);
  const marked = writeFailureInput(error, {
    kind,
    phase: prior?.phase ?? phaseFor(error),
    httpStatus: prior?.httpStatus ?? readStatus(error) ?? knownStatus,
    ...identityOf(error)
  });
  (marked as { benchAttemptTimedOut?: boolean }).benchAttemptTimedOut = timedOut;
  return marked;
}

function descriptorForProviderFailure(
  error: ProviderChatCompletionError
): {
  readonly kind: BenchTransportFailureKind;
  readonly phase: BenchTransportFailurePhase;
  readonly httpStatus?: number | null;
  readonly identity: ProviderFailureIdentity;
} {
  const identity = {
    providerCode: error.providerCode,
    providerType: error.providerType,
    bodyDigest: error.bodyDigest
  };
  if (error.kind === "response_parse_error") {
    const kind = error.inspectionReason === "schema"
      ? "response_schema_error"
      : "response_parse_error";
    return {
      kind,
      phase: kind === "response_schema_error" ? "response_schema" : "response_parse",
      identity
    };
  }
  return {
    kind: error.kind,
    phase: PROVIDER_FAILURE_PHASE[error.kind],
    ...(error.kind === "http_error" ? { httpStatus: error.httpStatus } : {}),
    identity
  };
}

function resolveFailureIdentity(
  error: Error,
  descriptor: Readonly<{
    identity?: ProviderFailureIdentity;
    rawBody?: string;
  }>
): Pick<SafeFailureFingerprintInput, "providerCode" | "providerType" | "rawBodyDigest"> {
  if (descriptor.identity !== undefined) {
    return {
      providerCode: descriptor.identity.providerCode,
      providerType: descriptor.identity.providerType,
      rawBodyDigest: descriptor.identity.bodyDigest
    };
  }
  if (descriptor.rawBody !== undefined) {
    const identity = providerFailureIdentityFromBody(descriptor.rawBody);
    return {
      providerCode: identity.providerCode,
      providerType: identity.providerType,
      rawBodyDigest: identity.bodyDigest
    };
  }
  return identityOf(error);
}

function identityOf(
  error: Error
): Pick<SafeFailureFingerprintInput, "providerCode" | "providerType" | "rawBodyDigest"> {
  const prior = readSafeFailureInput(error);
  if (prior !== undefined) {
    return {
      providerCode: prior.providerCode,
      providerType: prior.providerType,
      rawBodyDigest: prior.rawBodyDigest
    };
  }
  if (error instanceof ProviderChatCompletionError) {
    return {
      providerCode: error.providerCode,
      providerType: error.providerType,
      rawBodyDigest: error.bodyDigest
    };
  }
  return { providerCode: null, providerType: null, rawBodyDigest: null };
}

function phaseFor(error: Error): BenchTransportFailurePhase {
  if (error instanceof ProviderChatCompletionError) return PROVIDER_FAILURE_PHASE[error.kind];
  return "request";
}

function readStatus(error: Error): number | null {
  const prior = readSafeFailureInput(error)?.httpStatus;
  if (prior !== null && prior !== undefined) return prior;
  if (error instanceof ProviderChatCompletionError) return error.httpStatus;
  return null;
}

function writeFailureInput(
  error: Error,
  patch: Omit<SafeFailureFingerprintInput, "errorName" | "errorCode"> & {
    readonly errorName?: string | null;
    readonly errorCode?: string | null;
  },
  usage?: BenchProviderUsage
): Error {
  const prior = readSafeFailureInput(error);
  const input: SafeFailureFingerprintInput = Object.freeze({
    kind: patch.kind,
    phase: patch.phase,
    httpStatus: normalizeHttpStatus(patch.httpStatus),
    errorName: patch.errorName ?? prior?.errorName ?? safeProviderIdentityToken(error.name),
    errorCode: patch.errorCode ?? prior?.errorCode ?? readErrorCode(error),
    providerCode: patch.providerCode,
    providerType: patch.providerType,
    rawBodyDigest: patch.rawBodyDigest
  });
  Object.defineProperty(error, FAILURE_INPUT, { value: input, configurable: true });
  if (usage !== undefined) {
    Object.defineProperty(error, FAILURE_USAGE, {
      value: Object.freeze({ ...usage }), configurable: true
    });
  }
  return error;
}

function readGardenHttpFailureUsage(error: unknown): BenchProviderUsage | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { readonly [FAILURE_USAGE]?: BenchProviderUsage })[FAILURE_USAGE];
}

function readSafeFailureInput(error: unknown): SafeFailureFingerprintInput | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { readonly [FAILURE_INPUT]?: SafeFailureFingerprintInput })[FAILURE_INPUT];
}

function normalizeHttpStatus(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : null;
}

function readErrorCode(error: Error): string | null {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? safeProviderIdentityToken(String(code))
    : null;
}
