import { vi } from "vitest";

import {
  ClaimLifecycleState,
  MemoryDimension,
  ObjectLifecycleState,
  ScopeClass,
  type ClaimForm,
  type ContextDeliveryRecord,
  type DeferredObligation,
  type EventLogEntry,
  type MemoryEntry,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";

export {
  ClaimLifecycleState,
  GovernanceResolutionEventType,
  ObjectLifecycleState,
  SoulResolutionKind
} from "@do-soul/alaya-protocol";

import { ResolutionService } from "@do-soul/alaya-core";

import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandlerDependencies
} from "../../../mcp-memory/tool/tool-handler.js";

import { createSoulResolveHandler } from "../../../mcp-memory/tool/resolve-handler.js";
import { createSoulResolveEffectFixture } from "./soul-resolve-effect-fixture.js";
import { stubRecallIndex } from "../tool/mcp-memory-tool-handler-fixture.js";

// Shared soul.resolve wiring fixture. Parts keep only case differences.
// Maps + mock publish; not a live EventLog authenticity path.

export const FIXED_NOW = "2026-05-17T00:00:00.000Z";

export const context: McpMemoryToolCallContext = {
  workspaceId: "ws-e2e",
  runId: "run-e2e",
  agentTarget: "codex",
  sessionId: "soul-resolve-wiring-session"
};

export interface SoulResolveWiringHarness {
  readonly handler: ReturnType<typeof createMcpMemoryToolHandler>;
  readonly claims: Map<string, ClaimForm>;
  readonly memories: Map<string, MemoryEntry>;
  readonly obligations: Map<string, DeferredObligation>;
  readonly events: EventLogEntry[];
  readonly deliveries: Map<string, ContextDeliveryRecord>;
}

export function createHarness(): SoulResolveWiringHarness {
  let claimTransitionCounter = 0;
  let eventCounter = 0;
  const claims = new Map<string, ClaimForm>();
  const memories = new Map<string, MemoryEntry>();
  const obligations = new Map<string, DeferredObligation>();
  const events: EventLogEntry[] = [];
  const deliveries = new Map<string, ContextDeliveryRecord>();

  function publish(
    input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): EventLogEntry {
    eventCounter += 1;
    const entry: EventLogEntry = {
      ...input,
      event_id: `evt-${eventCounter}`,
      created_at: FIXED_NOW,
      revision: 0
    };
    events.push(entry);
    return entry;
  }

  const eventPublisher = {
    publish: vi.fn(async (input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
      publish(input)
    ),
    appendManyWithMutation: vi.fn(),
    appendManyWithMutationAndDetachPropagation: vi.fn()
  } as unknown as ConstructorParameters<typeof ResolutionService>[0]["eventPublisher"];

  const claimRepo = {
    findById: async (id: string) => claims.get(id) ?? null
  };
  const memoryRepo = {
    findById: async (id: string) => memories.get(id) ?? null
  };
  const claimService = {
    // Lifecycle change and composed audit events publish together so the
    // mock matches ClaimService.transitionLifecycle sink order.
    transitionLifecycle: async (
      objectId: string,
      newState: ClaimForm["claim_status"],
      _reason: string,
      _causedBy: "user" | "system" | "review" | "deterministic_rule" | "auditor" | "bootstrap",
      options?: {
        readonly additionalEventInputs?: readonly Omit<
          EventLogEntry,
          "event_id" | "created_at" | "revision"
        >[];
        readonly additionalEventsSink?: EventLogEntry[];
      }
    ): Promise<Readonly<ClaimForm>> => {
      claimTransitionCounter += 1;
      const current = claims.get(objectId);
      if (current === undefined) {
        throw new Error(`claim ${objectId} not found`);
      }
      const updated: ClaimForm = { ...current, claim_status: newState };
      claims.set(objectId, updated);
      publish({
        event_type: "soul.claim.lifecycle_changed",
        entity_type: "claim_form",
        entity_id: objectId,
        workspace_id: updated.workspace_id,
        run_id: null,
        caused_by: "claim_service",
        payload_json: {
          object_id: objectId,
          from_state: current.claim_status,
          to_state: newState,
          transition_index: claimTransitionCounter
        }
      });
      for (const eventInput of options?.additionalEventInputs ?? []) {
        const persisted = publish(eventInput);
        options?.additionalEventsSink?.push(persisted);
      }
      return updated;
    },
    recordEffectDecision: async (
      _receipt: unknown,
      eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
    ) => publish(eventInput)
  };
  const memoryService = {
    transitionLifecycle: async (
      objectId: string,
      nextState: MemoryEntry["lifecycle_state"],
      _reason: string,
      _causedBy: "user" | "system" | "review" | "deterministic_rule" | "auditor" | "bootstrap"
    ): Promise<Readonly<MemoryEntry>> => {
      const current = memories.get(objectId);
      if (current === undefined) {
        throw new Error(`memory ${objectId} not found`);
      }
      const updated: MemoryEntry = { ...current, lifecycle_state: nextState };
      memories.set(objectId, updated);
      return updated;
    },
    findById: async (id: string) => memories.get(id) ?? null,
    findByIdScoped: async (id: string, workspaceId: string) => {
      const memory = memories.get(id);
      return memory !== undefined && memory.workspace_id === workspaceId ? memory : null;
    },
    update: async () => {
      throw new Error("not used in this test");
    }
  };
  const deferredObligationService = {
    create: vi.fn(async (input: {
      readonly kind: DeferredObligation["kind"];
      readonly description: string;
      readonly sourceRunId: string;
      readonly workspaceId: string;
      readonly targetEntityId?: string;
      readonly expiresAt: string;
    }, options?: {
      readonly buildAdditionalEventInputs?: (
        obligation: Readonly<DeferredObligation>
      ) => readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[];
      readonly additionalEventsSink?: EventLogEntry[];
    }): Promise<Readonly<DeferredObligation>> => {
      const obligation: DeferredObligation = {
        obligation_id: `obligation-${obligations.size + 1}`,
        kind: input.kind,
        state: "pending",
        description: input.description,
        source_run_id: input.sourceRunId,
        workspace_id: input.workspaceId,
        target_entity_id: input.targetEntityId,
        created_at: FIXED_NOW,
        expires_at: input.expiresAt
      };
      obligations.set(obligation.obligation_id, obligation);
      for (const eventInput of options?.buildAdditionalEventInputs?.(obligation) ?? []) {
        const persisted = publish(eventInput);
        options?.additionalEventsSink?.push(persisted);
      }
      return obligation;
    })
  };

  const resolutionService = new ResolutionService({
    eventPublisher,
    claimRepo,
    memoryRepo,
    claimService,
    memoryService,
    deferredObligationService,
    ...createSoulResolveEffectFixture({ claims, deliveries }),
    now: () => FIXED_NOW
  });

  const soulResolveHandler = createSoulResolveHandler({
    resolutionService,
    trustStateRecorder: {
      findDeliveryById: async (id) => deliveries.get(id) ?? null
    },
    claimSourceReader: {
      findSourceObjectRefs: async (targetObjectId) => {
        const claim = claims.get(targetObjectId);
        return claim === undefined ? null : claim.source_object_refs;
      }
    }
  });

  const handlerDeps: McpMemoryToolHandlerDependencies = {
    now: () => FIXED_NOW,
    generateId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      };
    })(),
    recallService: {
      recall: vi.fn(async () => ({
        index: stubRecallIndex(["mem-source-1"]),
        candidates: [
          {
            object_id: "mem-source-1",
            object_kind: "memory_entry" as const,
            activation_score: 0.9,
            relevance_score: 0.8,
            content_preview: "memory backing a draft claim",
            token_estimate: 12,
            manifestation: "excerpt" as const,
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            origin_plane: "workspace_local" as const,
            staged_warnings: [
              {
                kind: "contradiction_pending" as const,
                severity: "blocking" as const,
                policy: "conflict_detection.v1",
                summary: "Memory contradicts memory-42; draft claim-draft-1 stages it.",
                resolution_options: [
                  "accept_pending",
                  "reject_pending",
                  "escalate_human"
                ] as const
              }
            ]
          }
        ],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 1,
        coarse_filter_count: 1,
        fine_assessment_count: 1
      }))
    },
    memoryService,
    signalService: {
      receiveSignal: vi.fn(async () => ({
        signal: {
          object_kind: "candidate_memory_signal",
          signal_kind: "potential_preference",
          object_id: "sig",
          scope_hint: "project",
          confidence: 0.9,
          evidence_refs: [],
          raw_payload: {},
          domain_tags: [],
          source: "model_tool"
        }
      })) as unknown as McpMemoryToolHandlerDependencies["signalService"]["receiveSignal"]
    },
    graphExploreService: { exploreOneHop: vi.fn(async () => []) },
    sessionOverrideService: { apply: vi.fn(async () => ({ runtime_id: "ovr" })) },
    trustStateRecorder: {
      recordDelivery: vi.fn(async (input: Omit<ContextDeliveryRecord, "audit_event_id">) => {
        const record: ContextDeliveryRecord = {
          ...input,
          audit_event_id: `delivery-evt-${deliveries.size + 1}`
        };
        deliveries.set(record.delivery_id, record);
        return record;
      }),
      recordUsage: vi.fn(async (input: Omit<UsageProofRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "usage-evt"
      })),
      findDeliveryById: vi.fn(async (id: string) => deliveries.get(id) ?? null)
    },
    soulResolveHandler
  };

  return {
    handler: createMcpMemoryToolHandler(handlerDeps),
    claims,
    memories,
    obligations,
    events,
    deliveries
  };
}

export function buildClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: overrides.object_id ?? "claim-draft-1",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    created_by: "test",
    governance_subject: {
      domain: "test",
      qualifiers: {},
      canonical_key: "test:test"
    },
    claim_kind: "preference",
    scope_class: ScopeClass.PROJECT,
    enforcement_level: "advisory",
    origin_tier: "consolidated",
    precedence_basis: "evidence_strength",
    proposition_digest: "digest",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: context.workspaceId,
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  } as ClaimForm;
}

export function buildMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: overrides.object_id ?? "mem-1",
    object_kind: "memory_entry",
    schema_version: 1,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    created_by: "test",
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "content",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: context.workspaceId,
    run_id: context.runId,
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  } as MemoryEntry;
}
