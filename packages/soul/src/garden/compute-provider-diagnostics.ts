import { SignalExtractorError } from "./pi-mono-extractor.js";

export interface SignalErrorDiagnostic {
  readonly is_signal_extractor_error: boolean;
  readonly kind: string | null;
  readonly name: string;
  readonly message: string;
  readonly cause_message: string | null;
}

export type ExtractorMetaSnapshot = {
  readonly recoveryKind: string;
  readonly retryCount: number;
  readonly retryClassification?: string;
};

export function extractRecoveryKindFromInputs(
  meta: ExtractorMetaSnapshot | null,
  _error: unknown
): string {
  if (meta !== null) {
    return meta.recoveryKind;
  }
  // No meta available — the extract() call threw before returning. The
  // recovery branch is unknowable in that case; emit "none" so the dump
  // shape stays stable for diagnostic readers.
  return "none";
}

export function extractRetryCountFromInputs(
  meta: ExtractorMetaSnapshot | null,
  error: unknown
): number {
  if (meta !== null) {
    return meta.retryCount;
  }
  if (error instanceof SignalExtractorError) {
    return error.retryCount;
  }
  return 0;
}

// invariant: the dump envelope's retry_classification field is "unknown"
// only when neither extractorMeta nor a typed SignalExtractorError carries
// the label — happens when a transport error fires before the extractor
// loop even started. The closed enum branches stay in sync with
// RetryClassification in pi-mono-extractor.ts.
export function extractRetryClassificationFromInputs(
  meta: ExtractorMetaSnapshot | null,
  error: unknown
): string {
  if (meta?.retryClassification !== undefined) {
    return meta.retryClassification;
  }
  if (error instanceof SignalExtractorError) {
    return error.retryClassification;
  }
  return "unknown";
}

export function extractSignalErrorDiagnostic(error: unknown): SignalErrorDiagnostic {
  if (error instanceof SignalExtractorError) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return {
      is_signal_extractor_error: true,
      kind: error.kind,
      name: error.name,
      message: error.message,
      cause_message: cause instanceof Error ? cause.message : null
    };
  }
  if (error instanceof Error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return {
      is_signal_extractor_error: false,
      kind: null,
      name: error.name,
      message: error.message,
      cause_message: cause instanceof Error ? cause.message : null
    };
  }
  return {
    is_signal_extractor_error: false,
    kind: null,
    name: "UnknownError",
    message: String(error),
    cause_message: null
  };
}

// Walk the .cause chain and surface any numeric HTTP status the transport
// happened to attach. The pi-mono extractor currently does not, but
// createGardenHttpExtractor (bench-runner) throws an Error whose .message
// embeds the status — we read both shapes so the dump captures whichever
// transport raised the failure.
export function extractStatusFromCauseChain(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current === "object") {
      const candidate = (current as { readonly status?: unknown }).status;
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
      const messageStatus = readStatusFromMessage(current);
      if (messageStatus !== null) {
        return messageStatus;
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    return null;
  }
  return null;
}

function readStatusFromMessage(value: object): number | null {
  if (!(value instanceof Error)) {
    return null;
  }
  const match = /\bHTTP\s+(\d{3})\b/u.exec(value.message);
  if (match === null) {
    return null;
  }
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractHeadersFromCauseChain(error: unknown): Record<string, string> | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current === "object") {
      const candidate = (current as { readonly headers?: unknown }).headers;
      const normalized = normalizeHeadersValue(candidate);
      if (normalized !== null) {
        return normalized;
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    return null;
  }
  return null;
}

function normalizeHeadersValue(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) {
    return null;
  }
  // Web Headers / Node Headers expose .entries(); plain Records expose keys.
  if (typeof value === "object" && typeof (value as { entries?: unknown }).entries === "function") {
    const out: Record<string, string> = {};
    try {
      for (const [key, val] of (value as Iterable<[string, string]>)) {
        if (typeof key === "string" && typeof val === "string") {
          out[key.toLowerCase()] = val;
        }
      }
      return out;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (typeof val === "string") {
        out[key.toLowerCase()] = val;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}
