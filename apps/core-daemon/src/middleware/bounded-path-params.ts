import type { Context, MiddlewareHandler } from "hono";
import { CoreError } from "@do-soul/alaya-core";
import { BoundedIdSchema } from "@do-soul/alaya-protocol";

const PARAM_CONTEXT_PREFIX = "boundedPathParam:";

export function boundedPathParams(...names: readonly string[]): MiddlewareHandler {
  return async (context, next) => {
    for (const name of names) {
      readBoundedPathParam(context, name);
    }
    await next();
  };
}

export function readBoundedPathParam(context: Context, name: string): string {
  const stored = context.get(`${PARAM_CONTEXT_PREFIX}${name}`);
  if (typeof stored === "string") {
    return stored;
  }

  const parsed = BoundedIdSchema.safeParse(context.req.param(name)?.trim());
  if (!parsed.success) {
    throw new CoreError("VALIDATION", `Invalid ${name}`);
  }

  context.set(`${PARAM_CONTEXT_PREFIX}${name}`, parsed.data);
  return parsed.data;
}
