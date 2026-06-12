import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FormationKind,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  MemoryDimension,
  MemoryGovernanceEventType,
  ProposalResolutionState,
  RecallContextEventType,
  RunMode,
  RunState,
  ScopeClass,
  SignalEventType,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type GardenTaskDescriptor,
  type MemoryEntry,
  type SoulEmitCandidateSignalResponse,
  type SoulMemorySearchResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReportContextUsageResponse,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
import { EventPublisher, SignalService } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  SqliteMemoryEntryRepo,
  SqliteProposalRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createAlayaMcpServer } from "../../mcp/mcp-server.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext
} from "../../mcp-memory/tool-handler.js";
import {
  SourceDeliveryAnchorValidationError,
  createMcpMemoryProposalWorkflow
} from "../../mcp-memory/proposal-workflow.js";
import { createTrustStateRecorder } from "../../trust-state.js";

const TRACE_SQL = `
WITH delivered AS (
  SELECT rowid AS event_order, event_type, payload_json, json_extract(payload_json, '$.delivery_id') AS delivery
  FROM event_log
  WHERE event_type = 'soul.recall.delivered'
    AND json_extract(payload_json, '$.delivery_id') = ?
),
reported AS (
  SELECT e.rowid AS event_order, e.event_type, e.payload_json
  FROM event_log e
  JOIN delivered d ON json_extract(e.payload_json, '$.delivery_id') = d.delivery
  WHERE e.event_type = 'soul.context_usage.reported'
),
anchored AS (
  SELECT e.rowid AS event_order, e.event_type, e.payload_json
  FROM event_log e
  JOIN json_each(e.payload_json, '$.source_delivery_ids') anchor
  JOIN delivered d ON anchor.value = d.delivery
  WHERE e.event_type IN ('soul.signal.emitted', 'soul.proposal.created', 'soul.proposal.resolved')
)
SELECT event_order, event_type, payload_json FROM delivered
UNION ALL SELECT event_order, event_type, payload_json FROM reported
UNION ALL SELECT event_order, event_type, payload_json FROM anchored
ORDER BY event_order
`;

const PROPOSAL_MEMBERSHIP_SQL = `
WITH target_delivery AS (
  SELECT ? AS delivery
)
SELECT e.event_type, e.payload_json
FROM event_log e
JOIN json_each(e.payload_json, '$.source_delivery_ids') anchor
JOIN target_delivery d ON anchor.value = d.delivery
WHERE e.event_type IN ('soul.proposal.created', 'soul.proposal.resolved')
ORDER BY e.rowid
`;

const harnesses = new Set<TrustworthyLoopHarness>();

afterEach(async () => {
  for (const harness of harnesses) {
    await harness.close();
  }
  harnesses.clear();
});

describe("trustworthy-loop-trace", () => {
  it("reconstructs the agent-driven five-event chain with delivery-id membership SQL only", async () => {
    assertTraceSqlUsesMembershipOnly();
    const harness = await createTrustworthyLoopHarness();

    const recall = await harness.callTool<SoulMemorySearchResponse>("soul.recall", {
      query: "pnpm workspace commands",
      scope_class: ScopeClass.PROJECT,
      dimension: MemoryDimension.PREFERENCE,
      domain_tags: null,
      max_results: 3
    });
    const objectId = recall.results[0]!.object_id;

    const usage = await harness.callTool<SoulReportContextUsageResponse>("soul.report_context_usage", {
      delivery_id: recall.delivery_id,
      usage_state: "used",
      used_object_ids: [objectId],
      reason: "Trace test consumed recalled memory."
    });
    expect(usage.status).toBe("recorded");

    const signal = await harness.callTool<SoulEmitCandidateSignalResponse>("soul.emit_candidate_signal", {
      signal_kind: "potential_preference",
      object_kind: "memory_entry",
      scope_hint: ScopeClass.PROJECT,
      domain_tags: ["tooling"],
      confidence: 0.95,
      evidence_refs: [objectId],
      raw_payload: { observation: "Use pnpm for workspace commands." },
      source_delivery_ids: [recall.delivery_id]
    });
    expect(signal.status).toBe("emitted");

    const proposal = await harness.callTool<SoulProposeMemoryUpdateResponse>("soul.propose_memory_update", {
      target_object_id: objectId,
      proposed_changes: { content: "Use pnpm and report memory usage." },
      reason: "Trace test proposal.",
      source_delivery_ids: [recall.delivery_id]
    });
    expect(proposal.status).toBe("created");

    const review = await harness.callTool<SoulReviewMemoryProposalResponse>("soul.review_memory_proposal", {
      proposal_id: proposal.proposal_id,
      verdict: "reject",
      reason: "Trace test rejects synthetic proposal.",
      reviewer_identity: TRACE_REVIEWER_IDENTITY,
      reviewer_token: TRACE_REVIEWER_TOKEN
    });
    expect(review.resolution_state).toBe(ProposalResolutionState.REJECTED);

    const rows = queryRows(harness.database, TRACE_SQL, recall.delivery_id);
    expect(rows.map((row) => row.event_type)).toEqual([
      RecallContextEventType.SOUL_RECALL_DELIVERED,
      RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
      SignalEventType.SOUL_SIGNAL_EMITTED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
    ]);
    expect(rows.map((row) => parsePayload(row).delivery_id).filter(Boolean)).toEqual([
      recall.delivery_id,
      recall.delivery_id
    ]);
    expect(
      rows
        .filter((row) =>
          row.event_type === SignalEventType.SOUL_SIGNAL_EMITTED ||
          row.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED ||
          row.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
        )
        .map((row) => parsePayload(row).source_delivery_ids)
    ).toEqual([[recall.delivery_id], [recall.delivery_id], [recall.delivery_id]]);
  });

  it("links multi-delivery proposal events by array membership through the public request path", async () => {
    const harness = await createTrustworthyLoopHarness();
    const first = await harness.callTool<SoulMemorySearchResponse>("soul.recall", {
      query: "first delivery",
      scope_class: ScopeClass.PROJECT,
      dimension: MemoryDimension.PREFERENCE,
      domain_tags: null,
      max_results: 3
    });
    const second = await harness.callTool<SoulMemorySearchResponse>("soul.recall", {
      query: "second delivery",
      scope_class: ScopeClass.PROJECT,
      dimension: MemoryDimension.PREFERENCE,
      domain_tags: null,
      max_results: 3
    });
    const sourceDeliveryIds = [first.delivery_id, second.delivery_id] as const;

    const proposal = await harness.callTool<SoulProposeMemoryUpdateResponse>("soul.propose_memory_update", {
      target_object_id: PRIMARY_MEMORY_ID,
      proposed_changes: { content: "Use pnpm from either recalled delivery." },
      reason: "Multi-delivery trace test.",
      source_delivery_ids: sourceDeliveryIds
    });
    await harness.callTool<SoulReviewMemoryProposalResponse>("soul.review_memory_proposal", {
      proposal_id: proposal.proposal_id,
      verdict: "reject",
      reason: "Trace test rejects synthetic proposal.",
      reviewer_identity: TRACE_REVIEWER_IDENTITY,
      reviewer_token: TRACE_REVIEWER_TOKEN
    });

    for (const deliveryId of sourceDeliveryIds) {
      const rows = queryRows(harness.database, PROPOSAL_MEMBERSHIP_SQL, deliveryId);
      expect(rows.map((row) => row.event_type)).toEqual([
        MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
        MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
      ]);
      expect(rows.map((row) => parsePayload(row).source_delivery_ids)).toEqual([
        sourceDeliveryIds,
        sourceDeliveryIds
      ]);
    }
  });

  it("keeps Garden-originated signals unanchored and does not warn for GARDEN_COMPILE", async () => {
    const warn = vi.fn();
    const harness = await createTrustworthyLoopHarness({ warn });
    harness.enqueueGardenTask("garden-task-1");

    await harness.callTool("garden.claim_task", { task_id: "garden-task-1" });
    await harness.callTool("garden.complete_task", {
      task_id: "garden-task-1",
      status: "completed",
      result_envelope: {
        candidate_signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "memory_entry",
            scope_hint: ScopeClass.PROJECT,
            domain_tags: ["garden"],
            confidence: 0.9,
            evidence_refs: [PRIMARY_MEMORY_ID],
            raw_payload: { observation: "Garden extracted an unanchored signal." }
          }
        ]
      }
    });

    const gardenSignals = (await harness.eventLogRepo.queryByType(SignalEventType.SOUL_SIGNAL_EMITTED))
      .filter((entry) => (entry.payload_json as { source?: unknown }).source === "garden_compile");
    expect(gardenSignals).toHaveLength(1);
    expect(gardenSignals[0]!.payload_json).not.toHaveProperty("source_delivery_ids");
    expect(warn).not.toHaveBeenCalled();
  });
});

const PRIMARY_MEMORY_ID = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
const TRACE_REVIEWER_IDENTITY = "user:trace-reviewer";
const TRACE_REVIEWER_TOKEN = "trace-review-token";

interface TraceRow {
  readonly event_order: number;
  readonly event_type: string;
  readonly payload_json: string;
}

interface TrustworthyLoopHarness {
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  callTool<TOutput = unknown>(toolName: string, args: Record<string, unknown>): Promise<TOutput>;
  close(): Promise<void>;
  enqueueGardenTask(taskId: string): void;
}

async function createTrustworthyLoopHarness(
  options: { readonly warn?: (message: string, meta: Record<string, unknown>) => void } = {}
): Promise<TrustworthyLoopHarness> {
  const database = initDatabase({ filename: ":memory:" });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const proposalRepo = new SqliteProposalRepo(database);
  const trustStateRepo = new SqliteTrustStateRepo(database);
  const runtimeNotifier = { notify: () => {}, notifyEntry: () => {} };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });
  const trustStateRecorder = createTrustStateRecorder({
    eventPublisher,
    repo: trustStateRepo,
    clock: () => "2026-05-11T00:00:00.000Z"
  });
  trustStateRecorder.markReady();
  const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  const signalService = new SignalService({ eventLogRepo, signalRepo, runtimeNotifier });
  const nextUuid = createUuidGenerator();
  const memoryService = {
    findById: async (objectId: string) => await memoryRepo.findById(objectId),
    findByIdScoped: async (objectId: string, workspaceId: string) => {
      const memory = await memoryRepo.findById(objectId);
      return memory?.workspace_id === workspaceId ? memory : null;
    },
    update: async (objectId: string) => {
      const memory = await memoryRepo.findById(objectId);
      if (memory === null) {
        throw new Error(`Missing memory ${objectId}`);
      }
      return memory;
    }
  };
  const context: McpMemoryToolCallContext = {
    workspaceId: "workspace-1",
    runId: "run-1",
    agentTarget: "codex",
    sessionId: "trustworthy-loop-trace-session",
    surfaceId: "trustworthy-loop-trace"
  };

  await seedWorkspaceRun(workspaceRepo, runRepo);
  await memoryRepo.create(createMemoryEntry());

  const proposalWorkflow = createMcpMemoryProposalWorkflow({
    now: () => "2026-05-11T00:00:00.000Z",
    generateObjectId: nextUuid,
    eventLogRepo,
    proposalRepo,
    runtimeNotifier,
    memoryService,
    sourceDeliveryAnchorValidator: {
      validate: async (sourceDeliveryIds, validationContext) => {
        for (const deliveryId of sourceDeliveryIds) {
          const delivery = await trustStateRecorder.findDeliveryById(deliveryId);
          if (
            delivery === null ||
            delivery.agent_target !== validationContext.agentTarget ||
            delivery.workspace_id !== validationContext.workspaceId ||
            delivery.run_id !== validationContext.runId
          ) {
            throw new SourceDeliveryAnchorValidationError(
              `source_delivery_ids entry '${deliveryId}' is not a valid recalled delivery for this context.`
            );
          }
        }
      }
    },
    reviewerIdentityBinding: {
      identity: TRACE_REVIEWER_IDENTITY,
      token: TRACE_REVIEWER_TOKEN
    }
  });
  const handler = createMcpMemoryToolHandler({
    now: () => "2026-05-11T00:00:00.000Z",
    generateId: nextUuid,
    recallService: {
      recall: async () => ({
        candidates: [createRecallCandidate()],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 1,
        coarse_filter_count: 1,
        fine_assessment_count: 1
      })
    },
    memoryService,
    signalService,
    graphExploreService: { exploreOneHop: async () => [] },
    sessionOverrideService: { apply: async () => ({ runtime_id: "override-1" }) },
    trustStateRecorder,
    eventPublisher,
    proposalWorkflow,
    gardenTaskRepo,
    warn: options.warn
  });
  const server = createAlayaMcpServer({
    memoryToolHandler: handler,
    contextProvider: () => context
  });
  const client = new Client(
    { name: "trustworthy-loop-trace-test", version: "test" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const harness: TrustworthyLoopHarness = {
    database,
    eventLogRepo,
    async callTool<TOutput>(toolName: string, args: Record<string, unknown>): Promise<TOutput> {
      const result = await client.callTool({ name: toolName, arguments: args });
      if (result.isError === true) {
        throw new Error(JSON.stringify(result.structuredContent ?? result.content));
      }
      const structuredContent = result.structuredContent as
        | Readonly<{ ok: true; output: TOutput }>
        | undefined;
      expect(structuredContent).toMatchObject({ ok: true });
      return structuredContent!.output;
    },
    async close() {
      await client.close();
      await server.close();
      database.close();
    },
    enqueueGardenTask(taskId: string) {
      gardenTaskRepo.enqueue({
        id: taskId,
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: createGardenTaskDescriptor(taskId),
        created_at: "2026-05-11T00:00:00.000Z"
      });
    }
  };

  harnesses.add(harness);
  return harness;
}

function assertTraceSqlUsesMembershipOnly(): void {
  expect(TRACE_SQL).toContain("json_each(e.payload_json, '$.source_delivery_ids')");
  expect(TRACE_SQL).not.toContain("entity_id");
  expect(TRACE_SQL).not.toContain("run_id");
  expect(TRACE_SQL).not.toContain("->> '$.source_delivery_ids'");
}

function queryRows(database: StorageDatabase, sql: string, deliveryId: string): readonly TraceRow[] {
  return database.connection.prepare(sql).all(deliveryId) as TraceRow[];
}

function parsePayload(row: TraceRow): Record<string, unknown> {
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

async function seedWorkspaceRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "Trustworthy Loop trace",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: PRIMARY_MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-11T00:00:00.000Z",
    updated_at: "2026-05-11T00:00:00.000Z",
    created_by: "trace-test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["tooling"],
    evidence_refs: ["trace-test"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
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

function createRecallCandidate() {
  return {
    object_id: PRIMARY_MEMORY_ID,
    object_kind: "memory_entry",
    activation_score: 0.9,
    relevance_score: 0.8,
    content_preview: "Use pnpm for workspace commands.",
    token_estimate: 12,
    manifestation: "excerpt",
    dimension: MemoryDimension.PREFERENCE,
    scope_class: ScopeClass.PROJECT,
    origin_plane: "workspace_local"
  } as const;
}

function createGardenTaskDescriptor(taskId: string): GardenTaskDescriptor {
  return {
    task_id: taskId,
    task_kind: GardenTaskKind.POST_TURN_EXTRACT,
    required_tier: GardenTier.TIER_2,
    workspace_id: "workspace-1",
    run_id: "run-1",
    target_object_refs: [PRIMARY_MEMORY_ID],
    priority: 20,
    created_at: "2026-05-11T00:00:00.000Z"
  };
}

function createUuidGenerator(): () => string {
  let counter = 0;
  return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
}

type _UsedTypes = Server;
