import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createInspectorAuthMiddleware } from "./auth.js";
import { registerInspectorConfigRoutes } from "./routes/config.js";
import { registerInspectorGraphRoutes } from "./routes/graph.js";
import { registerInspectorStatusRoutes } from "./routes/status.js";
import { registerInspectorStaticRoutes } from "./static.js";

export const INSPECTOR_ROUTE_SURFACE = Object.freeze([
  "GET /api/config/:workspaceId/soul",
  "PATCH /api/config/:workspaceId/soul",
  "GET /api/config/:workspaceId/strategy",
  "PATCH /api/config/:workspaceId/strategy",
  "GET /api/config/:workspaceId/environment",
  "PATCH /api/config/:workspaceId/environment",
  "GET /api/config/:workspaceId/embedding-supplement",
  "PATCH /api/config/runtime/embedding-supplement",
  "GET /api/graph/:workspaceId",
  "GET /api/status"
] as const);

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = resolve(__dirname, "..", "web", "dist");

export interface InspectorAppOptions {
  readonly token: string;
  readonly daemonUrl?: string;
  readonly staticRoot?: string;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => string;
}

export function createInspectorApp(options: InspectorAppOptions): Hono {
  const app = new Hono();
  app.onError((error, context) => {
    const status = isClientInputError(error) ? 400 : 500;
    console.error("[inspector] sanitized route error", summarizeInspectorError(error, status));
    return context.json({ error: status === 400 ? "invalid_request" : "internal_error" }, status);
  });
  app.use("*", createInspectorAuthMiddleware(options.token, { publicPathPrefixes: ["/assets/"] }));

  const proxyOptions = {
    daemonUrl: options.daemonUrl ?? "http://127.0.0.1:5173",
    fetchImpl: options.fetchImpl
  };
  registerInspectorConfigRoutes(app, proxyOptions);
  registerInspectorGraphRoutes(app, proxyOptions);
  registerInspectorStatusRoutes(app, proxyOptions);
  registerInspectorStaticRoutes(app, {
    staticRoot: options.staticRoot ?? defaultStaticRoot
  });
  return app;
}

function isClientInputError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError");
}

function summarizeInspectorError(
  error: unknown,
  status: number
): {
  readonly name: string;
  readonly status: number;
  readonly messageRedacted: true;
} {
  return {
    name: error instanceof Error ? error.name : "NonError",
    status,
    messageRedacted: true
  };
}
