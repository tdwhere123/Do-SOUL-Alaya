import type { Hono } from "hono";
import { CoreError } from "@do-what/core";
import { EngineError, EngineErrorKind } from "@do-what/protocol";

const SAFE_PUBLIC_VALIDATION_MESSAGES = new Set([
  "Origin is not allowed",
  "Unsupported file type",
  "File exceeds the 20 MB limit",
  "File not found",
  "Strict confirmation required",
  "governance route clock must return a valid ISO timestamp"
]);

export function registerErrorHandler(app: Hono): void {
  app.onError((error, context) => {
    if (error instanceof CoreError) {
      const publicMessage = publicMessageForCoreError(error);

      if (error.code === "VALIDATION" && publicMessage !== error.message) {
        console.error(
          "[daemon] sanitized core validation error",
          summarizeHandledError(error, {
            code: error.code,
            publicMessage
          })
        );
      }

      return context.json(
        {
          success: false,
          error: publicMessage
        },
        statusForCoreError(error)
      );
    }

    if (error instanceof EngineError) {
      console.error(
        "[daemon] sanitized engine error",
        summarizeHandledError(error, {
          kind: error.kind,
          publicMessage: publicMessageForEngineError(error)
        })
      );

      return context.json(
        {
          success: false,
          error: publicMessageForEngineError(error),
          kind: error.kind
        },
        502
      );
    }

    console.error("[daemon] unhandled error", summarizeUnhandledError(error));

    return context.json(
      {
        success: false,
        error: "Internal server error"
      },
      500
    );
  });
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

function summarizeUnhandledError(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: "NonError",
    message: String(error)
  };
}

function statusForCoreError(error: CoreError): 400 | 404 | 409 {
  switch (error.code) {
    case "VALIDATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "OBLIGATION_VIOLATION":
      return 409;
    default:
      return 400;
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
