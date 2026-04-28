import {
  parseSoulGraphDepth,
  parseSoulGraphLimit,
  type SoulGraph
} from "@do-what/protocol";
import type { Hono } from "hono";
import { CoreError } from "@do-what/core";

export interface SoulGraphRouteServices {
  readonly workspaceService: {
    getById(workspaceId: string): Promise<unknown>;
  };
  readonly soulGraphService: {
    buildSoulGraph(input: {
      readonly workspaceId: string;
      readonly depth: number;
      readonly limit: number;
    }): Promise<Readonly<SoulGraph>>;
  };
}

export function registerSoulGraphRoutes(app: Hono, services: SoulGraphRouteServices): void {
  app.get("/workspaces/:workspaceId/soul/graph", async (context) => {
    const workspaceId = parseRequiredString(context.req.param("workspaceId"), "workspaceId is required");
    await services.workspaceService.getById(workspaceId);

    const graph = await services.soulGraphService.buildSoulGraph({
      workspaceId,
      depth: parseValidatedSoulGraphParam(() => parseSoulGraphDepth(context.req.query("depth"))),
      limit: parseValidatedSoulGraphParam(() => parseSoulGraphLimit(context.req.query("limit")))
    });

    return context.json({ success: true, data: graph }, 200);
  });
}

function parseRequiredString(value: string | undefined, message: string): string {
  if (value === undefined) {
    throw new CoreError("VALIDATION", message);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CoreError("VALIDATION", message);
  }

  return trimmed;
}

function parseValidatedSoulGraphParam(parse: () => number): number {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new CoreError("VALIDATION", error.message);
    }

    throw error;
  }
}
