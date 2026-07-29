import type { Hono } from "hono";
import type { InspectorLaunchSessionStore } from "../launch/launch-session-store.js";

export function registerInspectorLaunchSessionRoutes(
  app: Hono,
  launchSessionStore: InspectorLaunchSessionStore
): void {
  app.post("/api/launch-session", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_request" }, 400);
    }

    const code = readLaunchCode(body);
    if (code === null) {
      return context.json({ error: "invalid_request" }, 400);
    }

    const token = launchSessionStore.redeem(code);
    if (token === null) {
      return context.json({ error: "launch_code_invalid_or_expired" }, 401);
    }

    return context.json({ token });
  });
}

function readLaunchCode(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("code" in body)) {
    return null;
  }
  const code = (body as { readonly code?: unknown }).code;
  if (typeof code !== "string") {
    return null;
  }
  const trimmed = code.trim();
  return trimmed.length === 0 ? null : trimmed;
}
