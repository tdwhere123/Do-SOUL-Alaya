import type { Hono } from "hono";
import { proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

export function registerInspectorStatusRoutes(app: Hono, options: InspectorProxyOptions): void {
  app.get("/api/status", async (context) =>
    await proxyDaemonJson(context, options, {
      method: "GET",
      path: "/status"
    })
  );
}
