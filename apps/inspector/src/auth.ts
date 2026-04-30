import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";

export function createInspectorAuthMiddleware(token: string): MiddlewareHandler {
  const expectedToken = normalizeToken(token);
  if (expectedToken === null) {
    throw new Error("inspector_token_missing");
  }

  return async (context: Context, next: Next) => {
    const providedToken = normalizeToken(
      context.req.query("token") ?? context.req.header("x-alaya-inspector-token")
    );
    if (providedToken === null || !constantTimeTokenEqual(providedToken, expectedToken)) {
      return context.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
}

export function constantTimeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const maxLength = Math.max(providedBuffer.length, expectedBuffer.length, 1);
  const paddedProvided = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  providedBuffer.copy(paddedProvided);
  expectedBuffer.copy(paddedExpected);
  return timingSafeEqual(paddedProvided, paddedExpected) && providedBuffer.length === expectedBuffer.length;
}

function normalizeToken(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}
