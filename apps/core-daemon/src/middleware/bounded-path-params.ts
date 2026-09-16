import type { Context, MiddlewareHandler } from "hono";
import { CoreError } from "@do-soul/alaya-core";
import { BoundedIdSchema } from "@do-soul/alaya-protocol";

const PARAM_CONTEXT_PREFIX = "boundedPathParam:";

export function boundedPathParams(...names: readonly string[]): MiddlewareHandler {
  return async (context, next) => {
    const keys = names.length > 0 ? names : Object.keys(collectMatchedPathParams(context));
    for (const name of keys) {
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

  const parsed = BoundedIdSchema.safeParse(rawMatchedPathParam(context, name)?.trim());
  if (!parsed.success) {
    throw new CoreError("VALIDATION", `Invalid ${name}`);
  }

  context.set(`${PARAM_CONTEXT_PREFIX}${name}`, parsed.data);
  return parsed.data;
}

function rawMatchedPathParam(context: Context, name: string): string | undefined {
  return context.req.param(name) ?? collectMatchedPathParams(context)[name];
}

function collectMatchedPathParams(context: Context): Record<string, string> {
  const request = context.req;
  const savedIndex = request.routeIndex;
  const params: Record<string, string> = {};
  try {
    // Hono `param()` is the current routeIndex only, so `use("*")` would otherwise
    // see the splat and skip ids registered on the matched handler.
    for (let index = 0; index < request.matchedRoutes.length; index += 1) {
      request.routeIndex = index;
      for (const [name, value] of Object.entries(request.param())) {
        if (name !== "*") {
          params[name] = value;
        }
      }
    }
  } finally {
    request.routeIndex = savedIndex;
  }
  return params;
}
