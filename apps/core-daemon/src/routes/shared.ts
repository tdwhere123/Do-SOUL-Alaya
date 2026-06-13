import type { Context } from "hono";
import { CoreError } from "@do-soul/alaya-core";

export const REQUEST_BODY_TOO_LARGE_MESSAGE = "Request body exceeds the 10 MB limit";
export const REQUEST_BODY_NOT_ALLOWED_MESSAGE = "Request body is not allowed for this route";

export async function parseJsonBody(readJson: () => Promise< unknown>): Promise< unknown> {
  try {
    return await readJson();
  } catch (error) {
    throwInvalidRequestBody(error);
  }
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
  if (declaredLength !== null && declaredLength > 10 * 1024 * 1024) {
    return "too_large";
  }

  const transferEncoding = normalizeOptionalHeader(context.req.header("transfer-encoding"));
  const body = context.req.raw.body;
  if (body === null) {
    if ((declaredLength ?? 0) > 0 || transferEncoding !== undefined) {
      return "unexpected";
    }
    return "none";
  }

  const reader = body.getReader();
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > 10 * 1024 * 1024) {
        return "too_large";
      }
    }
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return "too_large";
    }
    throw error;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  if (total > 0 || (declaredLength ?? 0) > 0 || transferEncoding !== undefined) {
    return "unexpected";
  }

  return "none";
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
