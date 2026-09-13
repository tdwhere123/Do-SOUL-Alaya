import { AlayaStatusSchema, type AlayaStatus } from "@do-soul/alaya-protocol";
import { getSqliteWriteQueuePort } from "@do-soul/alaya-storage";
import type { Hono } from "hono";

export interface StatusRouteServices {
  readonly startupStepsProvider: () => readonly string[];
  readonly principalCodingEngineAvailableProvider: () => boolean;
  readonly mcp: {
    listAllowedServerNames(): readonly string[];
    listEnrolledToolIds(): readonly string[];
    getHealth?(): {
      readonly servers: readonly {
        readonly server_name: string;
        readonly status: "active" | "inactive";
        readonly last_error: {
          readonly code: "MCP_EXTERNAL_TIMEOUT" | "MCP_EXTERNAL_TRANSPORT";
          readonly message: string;
        } | null;
      }[];
    };
  };
  readonly clock?: () => string;
  readonly probeDatabase?: () => boolean;
  readonly isDraining?: () => boolean;
  readonly getGardenComputeDegradedReason?: () => Promise<string | null>;
}

export function registerStatusRoutes(app: Hono, services: StatusRouteServices): void {
  app.get("/status", async (context) => {
    const status = await buildAlayaStatus(services);
    return context.json({ success: true, data: status }, 200);
  });
}

export async function buildAlayaStatus(services: StatusRouteServices): Promise<
  AlayaStatus & {
    readonly garden: {
      readonly schema_ok: boolean;
      readonly degraded_reason: string | null;
    };
  }
> {
  const dbReachable = services.probeDatabase?.() ?? false;
  const catalogHealth =
    typeof services.mcp.getHealth === "function" ? services.mcp.getHealth() : undefined;
  const catalogHealthy =
    catalogHealth === undefined ||
    catalogHealth.servers.every((server) => server.status === "active" && server.last_error === null);
  const draining = services.isDraining?.() === true;
  const gardenDegradedReason =
    (await services.getGardenComputeDegradedReason?.()) ?? null;
  const status = AlayaStatusSchema.parse({
    checked_at: (services.clock ?? (() => new Date().toISOString()))(),
    daemon: {
      ready:
        services.startupStepsProvider().includes("http-app") &&
        dbReachable &&
        !draining &&
        catalogHealthy,
      startup_steps: services.startupStepsProvider(),
      principal_coding_engine_available: services.principalCodingEngineAvailableProvider(),
      uptime_s: Math.max(0, process.uptime()),
      db_reachable: dbReachable,
      write_queue_depth: getSqliteWriteQueuePort()?.pendingCount() ?? 0
    },
    mcp: {
      enrolled_tools: services.mcp.listEnrolledToolIds().length,
      allowed_servers: services.mcp.listAllowedServerNames(),
      ...(catalogHealth === undefined ? {} : { catalog_health: catalogHealth })
    }
  });
  return {
    ...status,
    garden: {
      schema_ok: gardenDegradedReason === null,
      degraded_reason: gardenDegradedReason
    }
  };
}
