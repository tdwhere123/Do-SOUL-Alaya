import type { Context } from "hono";

const REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const REQUEST_BODY_PRESENCE_PROBE_TIMEOUT_MS = 0;

type RequestBodyInspection = "none" | "unexpected" | "too_large";

export function isRequestBodyTooLargeError(error: unknown): boolean {
  return readStatusCode(error) === 413 || readErrorName(error) === "BodyLimitError";
}

export async function rejectUnexpectedRequestBody(context: Context): Promise<Response | null> {
  const outcome = await inspectUnexpectedRequestBody(context);
  if (outcome === "none") return null;
  if (outcome === "too_large") return context.json({ error: "request_body_too_large" }, 413);
  return context.json({ error: "invalid_request" }, 400);
}

async function inspectUnexpectedRequestBody(context: Context): Promise<RequestBodyInspection> {
  const declaredLength = readDeclaredLength(context.req.header("content-length"));
  const transferEncoding = normalizeOptionalHeader(context.req.header("transfer-encoding"));
  const body = context.req.raw.body;
  if (body === null) return inspectBodylessRequest(declaredLength, transferEncoding);
  if (declaredLength !== null && declaredLength > REQUEST_BODY_LIMIT_BYTES) {
    await cancelRequestBodyStream(body, context);
    return "too_large";
  }
  return await probeRequestBodyStream(body, context);
}

function inspectBodylessRequest(
  declaredLength: number | null,
  transferEncoding: string | undefined
): RequestBodyInspection {
  if (declaredLength !== null && declaredLength > REQUEST_BODY_LIMIT_BYTES) return "too_large";
  if ((declaredLength ?? 0) > 0 || transferEncoding !== undefined) return "unexpected";
  return "none";
}

async function cancelRequestBodyStream(body: ReadableStream<Uint8Array>, context: Context): Promise<void> {
  await cancelReader(body.getReader(), context);
}

async function probeRequestBodyStream(
  body: ReadableStream<Uint8Array>,
  context: Context
): Promise<RequestBodyInspection> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readBodyProbe(reader),
      new Promise<"unexpected">((resolve) => {
        timer = setTimeout(() => resolve("unexpected"), REQUEST_BODY_PRESENCE_PROBE_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) return "too_large";
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await cancelReader(reader, context);
  }
}

async function readBodyProbe(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<RequestBodyInspection> {
  const { done, value } = await reader.read();
  if (done) return "none";
  return value.byteLength > REQUEST_BODY_LIMIT_BYTES ? "too_large" : "unexpected";
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  context: Context
): Promise<void> {
  await reader.cancel().catch((error: unknown) => {
    if (isRequestBodyTooLargeError(error)) return;
    console.warn("[routes/request-body-guard] request body reader cancel failed after inspection", {
      method: context.req.method,
      path: context.req.path,
      error
    });
  });
}

function readStatusCode(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly cause?: unknown;
  };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  return candidate.cause === undefined ? null : readStatusCode(candidate.cause);
}

function readErrorName(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  if (error === null || typeof error !== "object") return null;
  const candidate = error as { readonly cause?: unknown };
  return candidate.cause === undefined ? null : readErrorName(candidate.cause);
}

function readDeclaredLength(header: string | undefined): number | null {
  if (header === undefined) return null;
  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalHeader(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
