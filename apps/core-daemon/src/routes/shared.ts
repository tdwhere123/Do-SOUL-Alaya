import type { Context } from "hono";
import { CoreError } from "@do-soul/alaya-core";

export const REQUEST_BODY_TOO_LARGE_MESSAGE = "Request body exceeds the 10 MB limit";
export const REQUEST_BODY_NOT_ALLOWED_MESSAGE = "Request body is not allowed for this route";
const REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const REQUEST_BODY_PRESENCE_PROBE_TIMEOUT_MS = 0;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const MAX_LIST_OFFSET = 1_000_000;

export interface ListPagination {
  readonly limit: number;
  readonly offset: number;
}

export type JsonBodyValidator<T> = (value: unknown) => T;

export async function parseJsonBody(readJson: () => Promise<unknown>): Promise<unknown>;
export async function parseJsonBody<T>(
  readJson: () => Promise<unknown>,
  validate: JsonBodyValidator<T>
): Promise<T>;
export async function parseJsonBody<T>(
  readJson: () => Promise<unknown>,
  validate?: JsonBodyValidator<T>
): Promise<unknown> {
  let body: unknown;
  try {
    body = await readJson();
  } catch (error) {
    throwInvalidRequestBody(error);
  }

  return validate === undefined ? body : validate(body);
}

export function throwInvalidRequestBody(error: unknown): never {
  if (isRequestBodyTooLargeError(error)) {
    throw new CoreError("VALIDATION", REQUEST_BODY_TOO_LARGE_MESSAGE, { cause: error });
  }

  throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
}

export function isRequestBodyTooLargeError(error: unknown): boolean {
  if (error instanceof CoreError) {
    return error.message === REQUEST_BODY_TOO_LARGE_MESSAGE;
  }

  return readStatusCode(error) === 413 || readErrorName(error) === "BodyLimitError";
}

export function parseListPagination(context: Context): ListPagination {
  return {
    limit: parseBoundedInteger(
      context.req.query("limit"),
      "limit",
      DEFAULT_LIST_LIMIT,
      1,
      MAX_LIST_LIMIT
    ),
    offset: parseBoundedInteger(
      context.req.query("offset"),
      "offset",
      0,
      0,
      MAX_LIST_OFFSET
    )
  };
}

export function writeListPaginationHeaders(
  context: Context,
  totalCount: number,
  pagination: ListPagination
): void {
  context.header("x-total-count", String(totalCount));
  context.header("x-limit", String(pagination.limit));
  context.header("x-offset", String(pagination.offset));
}

function readStatusCode(error: unknown): number | null {
  if (error === null || typeof error !== "object") {
    return null;
  }

  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly cause?: unknown;
  };

  if (typeof candidate.status === "number") {
    return candidate.status;
  }

  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode;
  }

  return candidate.cause === undefined ? null : readStatusCode(candidate.cause);
}

function readErrorName(error: unknown): string | null {
  if (error instanceof Error) {
    return error.name;
  }

  if (error === null || typeof error !== "object") {
    return null;
  }

  const candidate = error as { readonly cause?: unknown };
  return candidate.cause === undefined ? null : readErrorName(candidate.cause);
}

function parseBoundedInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }

  const trimmed = value.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max || String(parsed) !== trimmed) {
    throw new CoreError("VALIDATION", `${name} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

export async function rejectUnexpectedRequestBody(context: Context): Promise<Response | null> {
  const outcome = await inspectUnexpectedRequestBody(context);

  if (outcome === "none") {
    return null;
  }

  if (outcome === "too_large") {
    return context.json(
      {
        success: false,
        error: REQUEST_BODY_TOO_LARGE_MESSAGE
      },
      413
    );
  }

  return context.json(
    {
      success: false,
      error: REQUEST_BODY_NOT_ALLOWED_MESSAGE
    },
    400
  );
}

async function inspectUnexpectedRequestBody(context: Context): Promise<"none" | "unexpected" | "too_large"> {
  const declaredLength = readDeclaredLength(context.req.header("content-length"));
  const transferEncoding = normalizeOptionalHeader(context.req.header("transfer-encoding"));
  const body = context.req.raw.body;
  if (body === null) {
    if (declaredLength !== null && declaredLength > REQUEST_BODY_LIMIT_BYTES) {
      return "too_large";
    }
    if ((declaredLength ?? 0) > 0 || transferEncoding !== undefined) {
      return "unexpected";
    }
    return "none";
  }

  if (declaredLength !== null && declaredLength > REQUEST_BODY_LIMIT_BYTES) {
    await cancelRequestBodyStream(body, context);
    return "too_large";
  }
  return await probeRequestBodyStream(body, context);
}

async function cancelRequestBodyStream(
  body: ReadableStream<Uint8Array>,
  context: Context
): Promise<void> {
  const reader = body.getReader();
  await reader.cancel().catch((error: unknown) => {
    if (isRequestBodyTooLargeError(error)) {
      return;
    }
    console.warn("[routes/shared] request body reader cancel failed after inspection", {
      method: context.req.method,
      path: context.req.path,
      error
    });
  });
}

async function probeRequestBodyStream(
  body: ReadableStream<Uint8Array>,
  context: Context
): Promise<"none" | "unexpected" | "too_large"> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read().then(({ done, value }) => {
        if (done) {
          return "none" as const;
        }
        if (value.byteLength > REQUEST_BODY_LIMIT_BYTES) {
          return "too_large" as const;
        }
        return "unexpected" as const;
      }),
      new Promise<"unexpected">((resolve) => {
        timer = setTimeout(() => resolve("unexpected"), REQUEST_BODY_PRESENCE_PROBE_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return "too_large";
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await reader.cancel().catch((error: unknown) => {
      if (isRequestBodyTooLargeError(error)) {
        return;
      }
      console.warn("[routes/shared] request body reader cancel failed after inspection", {
        method: context.req.method,
        path: context.req.path,
        error
      });
    });
  }
}

function readDeclaredLength(header: string | undefined): number | null {
  if (header === undefined) {
    return null;
  }

  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalHeader(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
