import { vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type MemoryEntry,
  type RecallCandidate,
  type SoulActiveConstraint,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolHandlerDependencies } from "../../mcp-memory/tool-handler.js";

export const context = {
  workspaceId: "ws1",
  runId: "run1",
  agentTarget: "codex",
  sessionId: "mcp-memory-tool-handler-session"
};

export function createDeps(): McpMemoryToolHandlerDependencies {
  let idCounter = 0;
  return {
    now: () => "2026-04-30T00:00:00.000Z",
    generateId: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
    recallService: {
      recall: vi.fn(async () => ({
        candidates: [
          {
            object_id: "mem1",
            object_kind: "memory_entry",
            activation_score: 0.9,
            relevance_score: 0.8,
            content_preview: "deployment rules",
            token_estimate: 12,
            manifestation: "excerpt",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            origin_plane: "workspace_local"
          }
        ],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 1,
        coarse_filter_count: 1,
        fine_assessment_count: 1
      })) as McpMemoryToolHandlerDependencies["recallService"]["recall"]
    },
    memoryService: {
      findById: vi.fn(async () => createMemory()),
      findByIdScoped: vi.fn(async (_objectId: string, workspaceId: string) => {
        const entry = createMemory();
        return entry.workspace_id === workspaceId ? entry : null;
      }),
      update: vi.fn(async (_objectId, fields) => createMemory(fields)),
      updateScoped: vi.fn(async (_objectId, _workspaceId, fields) => createMemory(fields))
    },
    signalService: {
      receiveSignal: vi.fn(async (signal: CandidateMemorySignal) => ({ signal }))
    },
    graphExploreService: {
      exploreOneHop: vi.fn(async () => [])
    },
    edgeProposalService: {
      proposeExplicitEdge: vi.fn(async () => ({
        proposal_id: "edge-proposal-1",
        status: "pending"
      })),
      listPending: vi.fn(() => ({
        proposals: [
          {
            proposal_id: "edge-proposal-1",
            source_memory_id: "mem1",
            target_memory_id: "mem2",
            edge_type: "recalls",
            trigger_source: "recall_cross_link",
            confidence: 0.7,
            reason: "operator reviewed relationship",
            source_signal_id: null,
            run_id: "run1",
            created_at: "2026-04-30T00:00:00.000Z",
            expires_at: null
          }
        ],
        total_count: 1
      })) as NonNullable<McpMemoryToolHandlerDependencies["edgeProposalService"]>["listPending"],
      batchReview: vi.fn(async () => ({
        accepted_count: 1,
        rejected_count: 0,
        reviewed_proposal_ids: ["edge-proposal-1"]
      }))
    },
    sessionOverrideService: {
      apply: vi.fn(async () => ({ runtime_id: "override1" }))
    },
    trustStateRecorder: {
      recordDelivery: vi.fn(async (input: Omit<ContextDeliveryRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "event1"
      })),
      recordUsage: vi.fn(async (input: Omit<UsageProofRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "event2"
      })),
      findDeliveryById: vi.fn(async (deliveryId: string) => createDeliveryRecord(deliveryId))
    }
  };
}

export function createRecallCandidate(overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    object_id: "mem1",
    object_kind: "memory_entry",
    activation_score: 0.9,
    relevance_score: 0.8,
    content_preview: "deployment rules",
    token_estimate: 12,
    manifestation: "excerpt",
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.PROJECT,
    origin_plane: "workspace_local",
    ...overrides
  };
}

export function createActiveConstraint(
  overrides: Partial<SoulActiveConstraint> = {}
): SoulActiveConstraint {
  return {
    object_id: "constraint-1",
    object_kind: "memory_entry",
    content: "active deployment rule",
    dimension: MemoryDimension.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    governance_state: {
      claim_status: null,
      governance_class: null,
      source_channels: ["dimension"]
    },
    ...overrides
  };
}

export function createMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "mem1",
    object_kind: "memory_entry",
    schema_version: 1,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    created_by: "test",
    lifecycle_state: "active",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "deployment rules",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "ws1",
    run_id: "run1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.9,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

export function createDeliveryRecord(deliveryId: string): ContextDeliveryRecord {
  return {
    delivery_id: deliveryId,
    agent_target: context.agentTarget,
    workspace_id: context.workspaceId,
    run_id: context.runId,
    delivered_object_ids: ["mem1"],
    delivered_at: "2026-04-30T00:00:00.000Z",
    audit_event_id: `event-${deliveryId}`
  };
}
