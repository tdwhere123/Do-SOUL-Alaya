import type { Hono } from "hono";
import { z } from "zod";
import { CoreError } from "@do-soul/alaya-core";
import { EngineError, EngineErrorKind } from "@do-soul/alaya-protocol";
import {
  isRequestBodyTooLargeError,
  REQUEST_BODY_TOO_LARGE_MESSAGE
} from "../routes/shared.js";
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from "../runtime/app.js";

const SAFE_PUBLIC_VALIDATION_MESSAGES = new Set([
  "Origin is not allowed",
  "Unsupported file type",
  "File exceeds the 20 MB limit",
  "File not found",
  "Strict confirmation required",
  "governance route clock must return a valid ISO timestamp",
  "Config patch body must be a JSON object"
]);

export interface ErrorLoggerPort {
  error(message: string, meta: Record<string, unknown>): void;
}

export function registerErrorHandler(app: Hono, logger: ErrorLoggerPort): void {
  app.onError((error, context) => handleDaemonError(error, context, logger));
}

function readRequestId(context: { get(name: string): unknown }): string | undefined {
  const requestId = context.get("requestId");
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

function summarizeHandledError(
  error: Error,
  extra: Record<string, unknown> = {}
): {
  readonly name: string;
  readonly messageRedacted: true;
  readonly causeName?: string;
  readonly causeRedacted?: true;
  readonly kind?: unknown;
  readonly code?: unknown;
  readonly publicMessage?: unknown;
} {
  return {
    name: error.name,
    messageRedacted: true,
    ...(error.cause instanceof Error
      ? {
          causeName: error.cause.name,
          causeRedacted: true
        }
      : {}),
    ...extra
  };
}

function summarizeUnhandledError(error: unknown, requestId?: string): {
  readonly name: string;
  readonly messageRedacted: true;
  readonly request_id?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      messageRedacted: true,
      ...(requestId === undefined ? {} : { request_id: requestId })
    };
  }

  return {
    name: "NonError",
    messageRedacted: true,
    ...(requestId === undefined ? {} : { request_id: requestId })
  };
}

function statusForCoreError(error: CoreError): 400 | 404 | 409 | 500 {
  switch (error.code) {
    case "VALIDATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "OBLIGATION_VIOLATION":
      return 409;
    default:
      return 500;
  }
}

function publicMessageForCoreError(error: CoreError): string {
  switch (error.code) {
    case "NOT_FOUND":
      return "Resource not found";
    case "CONFLICT":
      return "Request conflict";
    case "OBLIGATION_VIOLATION":
      return error.message;
    case "VALIDATION":
      return publicMessageForValidationError(error.message);
    default:
      return "Invalid request";
  }
}

function publicMessageForValidationError(message: string): string {
  if (message.startsWith("Invalid ")) {
    return message;
  }

  if (SAFE_PUBLIC_VALIDATION_MESSAGES.has(message)) {
    return message;
  }

  return "Invalid request";
}

function publicMessageForEngineError(error: EngineError): string {
  switch (error.kind) {
    case EngineErrorKind.NETWORK:
      return "The conversation provider could not be reached.";
    case EngineErrorKind.AUTH:
      return "The conversation provider rejected the configured credentials.";
    case EngineErrorKind.RATE_LIMIT:
      return "The conversation provider rate limit was reached.";
    case EngineErrorKind.MODEL_ERROR:
    default:
      return "The conversation provider could not complete the request.";
  }
}

interface ErrorHandlerContext {
  get(name: string): unknown;
  header(name: string, value: string): void;
  json(body: unknown, status?: number): Response;
}

function handleDaemonError(
  error: unknown,
  context: ErrorHandlerContext,
  logger: ErrorLoggerPort
): Response {
  const requestId = applyRequestIdHeaders(context);
  const bodyTooLargeResponse = handleRequestBodyTooLarge(error, context, logger, requestId);
  if (bodyTooLargeResponse !== null) {
    return bodyTooLargeResponse;
  }
  const coreErrorResponse = handleCoreDaemonError(error, context, logger, requestId);
  if (coreErrorResponse !== null) {
    return coreErrorResponse;
  }
  const engineErrorResponse = handleEngineDaemonError(error, context, logger, requestId);
  if (engineErrorResponse !== null) {
    return engineErrorResponse;
  }
  const zodErrorResponse = handleZodDaemonError(error, context, logger, requestId);
  if (zodErrorResponse !== null) {
    return zodErrorResponse;
  }
  logger.error("[daemon] unhandled error", summarizeUnhandledError(error, requestId));
  return context.json({ success: false, error: "Internal server error" }, 500);
}

function applyRequestIdHeaders(context: ErrorHandlerContext): string | undefined {
  const requestId = readRequestId(context);
  if (requestId !== undefined) {
    context.header(REQUEST_ID_HEADER, requestId);
    context.header(CORRELATION_ID_HEADER, requestId);
  }
  return requestId;
}

function handleRequestBodyTooLarge(
  error: unknown,
  context: ErrorHandlerContext,
  logger: ErrorLoggerPort,
  requestId?: string
): Response | null {
  if (!isRequestBodyTooLargeError(error)) {
    return null;
  }
  logger.error(
    "[daemon] sanitized request body limit error",
    summarizeHandledError(error instanceof Error ? error : new Error("request body too large"), {
      publicMessage: REQUEST_BODY_TOO_LARGE_MESSAGE,
      request_id: requestId
    })
  );
  return context.json({ success: false, error: REQUEST_BODY_TOO_LARGE_MESSAGE }, 413);
}

function handleCoreDaemonError(
  error: unknown,
  context: ErrorHandlerContext,
  logger: ErrorLoggerPort,
  requestId?: string
): Response | null {
  if (!(error instanceof CoreError)) {
    return null;
  }
  const publicMessage = publicMessageForCoreError(error);
  if (error.code === "VALIDATION" && publicMessage !== error.message) {
    logger.error(
      "[daemon] sanitized core validation error",
      summarizeHandledError(error, {
        code: error.code,
        publicMessage,
        request_id: requestId
      })
    );
  }
  return context.json({ success: false, error: publicMessage }, statusForCoreError(error));
}

function handleEngineDaemonError(
  error: unknown,
  context: ErrorHandlerContext,
  logger: ErrorLoggerPort,
  requestId?: string
): Response | null {
  if (!(error instanceof EngineError)) {
    return null;
  }
  const publicMessage = publicMessageForEngineError(error);
  logger.error(
    "[daemon] sanitized engine error",
    summarizeHandledError(error, {
      kind: error.kind,
      publicMessage,
      request_id: requestId
    })
  );
  return context.json({ success: false, error: publicMessage, kind: error.kind }, 502);
}

function handleZodDaemonError(
  error: unknown,
  context: ErrorHandlerContext,
  logger: ErrorLoggerPort,
  requestId?: string
): Response | null {
  if (!(error instanceof z.ZodError)) {
    return null;
  }
  logger.error(
    "[daemon] sanitized zod validation error",
    summarizeHandledError(error, {
      publicMessage: "Invalid request",
      request_id: requestId
    })
  );
  return context.json({ success: false, error: "Invalid request" }, 400);
}
