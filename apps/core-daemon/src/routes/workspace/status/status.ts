import { AlayaStatusSchema, type AlayaStatus } from "@do-soul/alaya-protocol";
import type { Hono } from "hono";

export interface StatusRouteServices {
  readonly startupStepsProvider: () => readonly string[];
  readonly principalCodingEngineAvailableProvider: () => boolean;
  readonly mcp: {
    listAllowedServerNames(): readonly string[];
    listEnrolledToolIds(): readonly string[];
  };
  readonly clock?: () => string;
}

export function registerStatusRoutes(app: Hono, services: StatusRouteServices): void {
  app.get("/status", (context) => {
    const status = buildAlayaStatus(services);
    return context.json({ success: true, data: status }, 200);
  });
}

export function buildAlayaStatus(services: StatusRouteServices): AlayaStatus {
  return AlayaStatusSchema.parse({
    checked_at: (services.clock ?? (() => new Date().toISOString()))(),
    daemon: {
      ready: services.startupStepsProvider().includes("http-app"),
      startup_steps: services.startupStepsProvider(),
      principal_coding_engine_available: services.principalCodingEngineAvailableProvider()
    },
    mcp: {
      enrolled_tools: services.mcp.listEnrolledToolIds().length,
      allowed_servers: services.mcp.listAllowedServerNames()
    }
  });
}
