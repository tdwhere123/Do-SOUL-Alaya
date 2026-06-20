import { expect } from "vitest";
import type { ContextDeliveryRecord } from "@do-soul/alaya-protocol";
import { buildGardenTaskSignalId } from "../../garden/index.js";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolCallResult
} from "../../mcp-memory/tool-handler.js";

export function createMemoryEntry(overrides: Partial<ReturnType<typeof createMemoryEntryBase>> = {}) {
  return {
    ...createMemoryEntryBase(),
    ...overrides
  } as const;
}

function createMemoryEntryBase() {
  return {
    // Widened from the "memory-a" literal so callers can override with a
    // dynamic object_id (e.g. findByIdScoped echoing its argument).
    object_id: "memory-a" as string,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "test",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Use pnpm.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  } as const;
}

export function createDeliveryRecord(
  overrides: Partial<ContextDeliveryRecord> = {}
): ContextDeliveryRecord {
  return {
    delivery_id: "delivery-1",
    agent_target: "codex",
    workspace_id: "workspace-1",
    run_id: "run-1",
    // Both memory-a and memory-b are served by this delivery so a usage report
    // that cites either id stays a subset of the server-side delivered set.
    // see also: mcp-memory/tool-handler.ts validateReportedRecallHits.
    delivered_object_ids: ["memory-a", "memory-b"],
    delivered_at: "2026-05-07T00:00:00.000Z",
    audit_event_id: "event-delivery",
    ...overrides
  };
}

export function defaultContext(): McpMemoryToolCallContext {
  return {
    workspaceId: "workspace-1",
    runId: "run-1",
    agentTarget: "codex",
    sessionId: "post-turn-extract-test-session",
    surfaceId: "post-turn-extract-test"
  };
}

export function noRunContext(): McpMemoryToolCallContext {
  return {
    ...defaultContext(),
    runId: null,
    sessionId: "mcp-session-without-run"
  };
}

export function sessionRunContext(): McpMemoryToolCallContext {
  return {
    ...defaultContext(),
    runId: "mcp-session-run-1",
    sessionId: "mcp-session-run-1"
  };
}

export function unwrapOk<T>(result: McpMemoryToolCallResult): T {
  expect(result).toMatchObject({ ok: true });
  return (result as Extract<McpMemoryToolCallResult, { ok: true }>).output as T;
}

export const gardenTaskSignalId = buildGardenTaskSignalId;
