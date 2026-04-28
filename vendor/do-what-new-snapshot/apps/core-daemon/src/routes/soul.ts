import {
  GraphExploreDirSchema,
  MemoryGraphEdgeTypeSchema,
  type GraphExploreDir,
  type GraphNeighbor,
  type MemoryGraphEdgeTypeValue,
  type TopologyExplorationResult
} from "@do-what/protocol";
import type { Hono } from "hono";
import { CoreError } from "@do-what/core";
import { parseJsonBody } from "./shared.js";

export interface SoulApprovalResolution {
  readonly approval_id: string;
  readonly result: "approved" | "rejected";
  readonly resolved_at: string;
}

export interface SoulApprovalActionInput {
  readonly approvalId: string;
  readonly runId: string;
  readonly causedBy: string;
}

interface TopologyAuditPort {
  appendPathTopologyExploreCompleted(topology: Readonly<TopologyExplorationResult>): Promise<unknown>;
}

export interface SoulRouteServices {
  readonly workspaceService: {
    getById(workspaceId: string): Promise<unknown>;
  };
  readonly topologyAuditService?: TopologyAuditPort;
  readonly graphExploreService?: {
    exploreOneHop(
      memoryId: string,
      workspaceId: string,
      options?: {
        edgeTypes?: readonly MemoryGraphEdgeTypeValue[];
        direction?: GraphExploreDir;
      }
    ): Promise<readonly GraphNeighbor[]>;
  };
  readonly topologyService?: {
    explore(workspaceId: string): Promise<Readonly<TopologyExplorationResult>>;
  };
  readonly approvalService?: {
    approve(input: SoulApprovalActionInput): Promise<SoulApprovalResolution>;
    reject(input: SoulApprovalActionInput): Promise<SoulApprovalResolution>;
  };
}

export function registerSoulRoutes(app: Hono, services: SoulRouteServices): void {
  const topologyService = services.topologyService;

  if (topologyService !== undefined) {
    const topologyAuditService = services.topologyAuditService;
    if (topologyAuditService === undefined) {
      throw new Error("TopologyService requires topology audit logging.");
    }

    app.get("/soul/workspaces/:workspaceId/topology", async (context) => {
      const workspaceId = parseRequiredString(context.req.param("workspaceId"), "workspaceId is required");
      await services.workspaceService.getById(workspaceId);
      const topology = await topologyService.explore(workspaceId);
      await topologyAuditService.appendPathTopologyExploreCompleted(topology);

      return context.json({ success: true, data: topology }, 200);
    });
  }

  const graphExploreService = services.graphExploreService;

  if (graphExploreService !== undefined) {
    app.get("/soul/memories/:objectId/graph-neighbors", async (context) => {
      const memoryId = context.req.param("objectId").trim();
      const workspaceId = (context.req.query("workspace_id") ?? "").trim();

      if (memoryId.length === 0) {
        throw new CoreError("VALIDATION", "objectId is required");
      }

      if (workspaceId.length === 0) {
        throw new CoreError("VALIDATION", "workspace_id is required");
      }

      const direction = parseGraphExploreDirection(context.req.query("direction"));
      const edgeTypes = (context.req.queries("edge_types") ?? []).map(parseGraphEdgeTypeQueryValue);
      const neighbors = await graphExploreService.exploreOneHop(memoryId, workspaceId, {
        direction,
        edgeTypes: edgeTypes.length > 0 ? edgeTypes : undefined
      });

      return context.json({ success: true, data: neighbors }, 200);
    });
  }

  const approvalService = services.approvalService;

  if (approvalService !== undefined) {
    app.post("/soul/approval/:approvalId/approve", async (context) => {
      const approvalId = parseRequiredString(context.req.param("approvalId"), "approvalId is required");
      const body = await parseJsonBody(context.req.json.bind(context.req));
      const runId = parseRunIdFromBody(body);
      const resolution = await approvalService.approve({
        approvalId,
        runId,
        causedBy: "user_action"
      });

      return context.json({ success: true, data: resolution }, 200);
    });

    app.post("/soul/approval/:approvalId/reject", async (context) => {
      const approvalId = parseRequiredString(context.req.param("approvalId"), "approvalId is required");
      const body = await parseJsonBody(context.req.json.bind(context.req));
      const runId = parseRunIdFromBody(body);
      const resolution = await approvalService.reject({
        approvalId,
        runId,
        causedBy: "user_action"
      });

      return context.json({ success: true, data: resolution }, 200);
    });
  }
}

function parseGraphExploreDirection(value: string | undefined): GraphExploreDir | undefined {
  if (value === undefined) {
    return undefined;
  }

  const result = GraphExploreDirSchema.safeParse(value);

  if (!result.success) {
    throw new CoreError("VALIDATION", "Invalid direction", { cause: result.error });
  }

  return result.data;
}

function parseGraphEdgeTypeQueryValue(value: string): MemoryGraphEdgeTypeValue {
  const result = MemoryGraphEdgeTypeSchema.safeParse(value);

  if (!result.success) {
    throw new CoreError("VALIDATION", "Invalid edge_types query value", { cause: result.error });
  }

  return result.data;
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

function parseRunIdFromBody(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CoreError("VALIDATION", "Invalid request body");
  }

  const runId = (body as { readonly run_id?: unknown }).run_id;

  if (typeof runId !== "string") {
    throw new CoreError("VALIDATION", "run_id is required");
  }

  return parseRequiredString(runId, "run_id is required");
}
