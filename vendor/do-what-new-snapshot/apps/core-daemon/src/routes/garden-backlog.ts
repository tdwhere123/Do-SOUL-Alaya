import type { GardenBacklogSnapshot } from "@do-what/protocol";
import type { Hono } from "hono";

export interface GardenBacklogRouteService {
  getSnapshot(): GardenBacklogSnapshot;
}

export function registerGardenBacklogRoutes(app: Hono, services: {
  readonly gardenBacklogTelemetryService: GardenBacklogRouteService;
}): void {
  app.get("/garden/backlog", async (context) =>
    context.json(
      {
        success: true,
        data: services.gardenBacklogTelemetryService.getSnapshot()
      },
      200
    )
  );
}
