import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaimLifecycleState,
  GovernanceResolutionEventType,
  MemoryDimension,
  ObjectLifecycleState,
  ScopeClass,
  SoulResolutionKind,
  WorkspaceKind,
  WorkspaceState,
  canonicalGovernanceSubject,
  type ClaimForm,
  type DeferredObligation,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteClaimFormRepo,
  SqliteEventLogRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  ResolutionService,
  type ResolutionServiceClaimRepoPort,
  type ResolutionServiceClaimServicePort,
  type ResolutionServiceMemoryRepoPort,
  type ResolutionServiceMemoryServicePort
} from "../resolution-service.js";
import { ClaimService } from "../claim-service.js";
import { EventPublisher } from "../event-publisher.js";
import type { DeferredObligationService } from "../deferred-obligation-service.js";

const FIXED_NOW = "2026-05-17T00:00:00.000Z";

interface Harness {
  readonly service: ResolutionService;
  readonly claimRepo: ResolutionServiceClaimRepoPort & {
    readonly findById: ReturnType<typeof vi.fn>;
  };
  readonly memoryRepo: ResolutionServiceMemoryRepoPort & {
    readonly findById: ReturnType<typeof vi.fn>;
  };
  readonly claimService: ResolutionServiceClaimServicePort & {
    readonly transitionLifecycle: ReturnType<typeof vi.fn>;
  };
  readonly memoryService: ResolutionServiceMemoryServicePort & {
    readonly transitionLifecycle: ReturnType<typeof vi.fn>;
  };
  readonly deferredObligationService: Pick<DeferredObligationService, "create"> & {
    readonly create: ReturnType<typeof vi.fn>;
  };
  readonly published: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>;
}

function createHarness(): Harness {
  const published: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
  let counter = 0;
  const eventPublisher = {
    publish: vi.fn(async (input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      counter += 1;
      published.push(input);
      return {
        ...input,
        event_id: `evt-${counter}`,
        created_at: FIXED_NOW,
        revision: 0
      } satisfies EventLogEntry;
    })
  } as unknown as EventPublisher;
  const claimRepo = { findById: vi.fn(async (_id: string) => null as ClaimForm | null) };
  const memoryRepo = { findById: vi.fn(async (_id: string) => null as MemoryEntry | null) };
  const claimService = {
    // The mock honors the atomic-audit-composition contract: additional
    // event inputs are persisted (in the same logical transaction as the
    // claim mutation) and the persisted rows are pushed into the sink in
    // input order, exactly like ClaimService.transitionLifecycle does.
    transitionLifecycle: vi.fn(async (
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
      for (const eventInput of options?.additionalEventInputs ?? []) {
        counter += 1;
        published.push(eventInput);
        options?.additionalEventsSink?.push({
          ...eventInput,
          event_id: `evt-${counter}`,
          created_at: FIXED_NOW,
          revision: 0
        } satisfies EventLogEntry);
      }
      return buildClaim({ object_id: objectId, claim_status: newState });
    })
  };
  const memoryService = {
    transitionLifecycle: vi.fn(async (
      objectId: string,
      nextState: MemoryEntry["lifecycle_state"],
      _reason: string,
      _causedBy: "user" | "system" | "review" | "deterministic_rule" | "auditor" | "bootstrap"
    ): Promise<Readonly<MemoryEntry>> =>
      buildMemory({ object_id: objectId, lifecycle_state: nextState }))
  };
  const deferredObligationService = {
    create: vi.fn(async (): Promise<Readonly<DeferredObligation>> => ({
      obligation_id: "obligation-1",
      kind: "evidence_refresh",
      state: "pending",
      description: "test-defer",
      source_run_id: "run-1",
      workspace_id: "ws-1",
      target_entity_id: "claim-1",
      created_at: FIXED_NOW,
      expires_at: "2026-05-18T00:00:00.000Z"
    }))
  };
  const service = new ResolutionService({
    eventPublisher,
    claimRepo,
    memoryRepo,
    claimService,
    memoryService,
    deferredObligationService,
    now: () => FIXED_NOW
  });
  return {
    service,
    claimRepo,
    memoryRepo,
    claimService,
    memoryService,
    deferredObligationService,
    published
  };
}

function buildClaim(overrides: Partial<ClaimForm> = {}): Readonly<ClaimForm> {
  return {
    object_id: overrides.object_id ?? "claim-1",
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
    workspace_id: "ws-1",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  } as ClaimForm;
}

function buildMemory(overrides: Partial<MemoryEntry> = {}): Readonly<MemoryEntry> {
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
    workspace_id: "ws-1",
    run_id: "run-1",
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

const baseInput = {
  targetObjectId: "claim-1",
  workspaceId: "ws-1",
  runId: "run-1",
  agentTarget: "codex",
  deliveryId: "delivery-1"
};

describe("ResolutionService dispatch", () => {
  it("confirm activates a draft claim and emits the confirm event", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(buildClaim({ claim_status: ClaimLifecycleState.DRAFT }));
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.CONFIRM
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.activatedClaimId).toBe("claim-1");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
    );
    // The resolution audit event is composed into the claim transition so
    // the claim_status mutation and the audit row append atomically.
    expect(harness.claimService.transitionLifecycle).toHaveBeenCalledWith(
      "claim-1",
      ClaimLifecycleState.ACTIVE,
      expect.any(String),
      "user",
      expect.objectContaining({
        additionalEventInputs: [
          expect.objectContaining({
            event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
          })
        ],
        additionalEventsSink: expect.any(Array)
      })
    );
    expect(harness.published).toHaveLength(1);
    expect(harness.published[0].event_type).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
    );
    expect(harness.published[0].payload_json).toMatchObject({
      target_object_id: "claim-1",
      resolution: "confirm",
      activated_claim_id: "claim-1"
    });
  });

  it("reject archives a non-draft claim and emits the reject event", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ claim_status: ClaimLifecycleState.ACTIVE })
    );
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.REJECT
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
    );
    expect(harness.claimService.transitionLifecycle).toHaveBeenCalledWith(
      "claim-1",
      ClaimLifecycleState.ARCHIVED,
      expect.any(String),
      "user",
      expect.objectContaining({
        additionalEventInputs: [
          expect.objectContaining({
            event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
          })
        ],
        additionalEventsSink: expect.any(Array)
      })
    );
    expect(harness.published[0].event_type).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
    );
  });

  // invariant: agents resolving a staged warning's reject_pending
  // option (which mapResolutionOptionToKind sends as SoulResolutionKind.REJECT)
  // must be able to archive a DRAFT claim directly. Without the
  // draft -> archived transition, the advertised resolution would
  // throw CONFLICT and the agent has no way to decline a pending claim.
  it("reject archives a DRAFT claim directly", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ claim_status: ClaimLifecycleState.DRAFT })
    );
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.REJECT
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
    );
    expect(harness.claimService.transitionLifecycle).toHaveBeenCalledWith(
      "claim-1",
      ClaimLifecycleState.ARCHIVED,
      expect.any(String),
      "user",
      expect.objectContaining({
        additionalEventInputs: [
          expect.objectContaining({
            event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
          })
        ],
        additionalEventsSink: expect.any(Array)
      })
    );
  });

  it("correct requires a non-empty correction prose and emits the correct event", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValue(
      buildClaim({ claim_status: ClaimLifecycleState.ACTIVE })
    );
    await expect(
      harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.CORRECT
      })
    ).rejects.toThrow(/correction/);
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.CORRECT,
      correction: "the canonical key should be foo"
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_CORRECT_APPLIED
    );
    expect(harness.claimService.transitionLifecycle).not.toHaveBeenCalled();
  });

  it("stale transitions an active memory_entry to dormant", async () => {
    const harness = createHarness();
    harness.memoryRepo.findById.mockResolvedValueOnce(
      buildMemory({ object_id: "mem-1", lifecycle_state: ObjectLifecycleState.ACTIVE })
    );
    const outcome = await harness.service.resolve({
      ...baseInput,
      targetObjectId: "mem-1",
      resolution: SoulResolutionKind.STALE
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_STALE_APPLIED
    );
    expect(harness.memoryService.transitionLifecycle).toHaveBeenCalledWith(
      "mem-1",
      ObjectLifecycleState.DORMANT,
      expect.any(String),
      "user"
    );
  });

  it("defer creates a DeferredObligation and emits the defer event", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(buildClaim({ claim_status: ClaimLifecycleState.ACTIVE }));
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.DEFER,
      deferUntil: "2026-05-18T00:00:00.000Z",
      reason: "need more evidence"
    });
    expect(outcome.status).toBe("deferred");
    expect(outcome.obligationId).toBe("obligation-1");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_DEFER_APPLIED
    );
    expect(harness.deferredObligationService.create).toHaveBeenCalledWith({
      kind: "evidence_refresh",
      description: "need more evidence",
      sourceRunId: "run-1",
      workspaceId: "ws-1",
      targetEntityId: "claim-1",
      expiresAt: "2026-05-18T00:00:00.000Z"
    });
    expect(harness.published[0].payload_json).toMatchObject({
      resolution: "defer",
      obligation_id: "obligation-1"
    });
  });

  it("defer requires defer_until", async () => {
    const harness = createHarness();
    await expect(
      harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.DEFER
      })
    ).rejects.toThrow(/defer_until/);
  });

  it("not_relevant emits the dismissal event without lifecycle changes", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ claim_status: ClaimLifecycleState.ACTIVE })
    );
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.NOT_RELEVANT
    });
    expect(outcome.status).toBe("noop");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_NOT_RELEVANT_APPLIED
    );
    expect(harness.claimService.transitionLifecycle).not.toHaveBeenCalled();
    expect(harness.memoryService.transitionLifecycle).not.toHaveBeenCalled();
  });

  it("rejects workspace-mismatched targets", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ workspace_id: "other-ws", claim_status: ClaimLifecycleState.DRAFT })
    );
    await expect(
      harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.CONFIRM
      })
    ).rejects.toThrow(/workspace/);
  });

  it("confirm rejects when the claim is not in draft", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ claim_status: ClaimLifecycleState.ACTIVE })
    );
    await expect(
      harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.CONFIRM
      })
    ).rejects.toThrow(/draft/);
  });
});

// invariant: B5 — proves the atomic-rollback contract on real SQLite,
// not just the wiring. The resolution-confirm path composes its
// governance-resolution audit event into the SAME appendManyWithMutation
// transaction as the claim_status mutation. A throw inside the mutate
// callback must roll BOTH back: neither the audit-event EventLog row nor
// the claim_status change may survive. Mocking transitionLifecycle (the
// dispatch tests above) cannot prove this — only a genuine SQLite
// transaction can.
// see also: packages/core/src/claim-service.ts applyLifecycleTransition
describe("ResolutionService confirm atomicity (real SQLite)", () => {
  const databases = new Set<ReturnType<typeof initDatabase>>();

  afterEach(() => {
    for (const database of databases) {
      database.close();
    }
    databases.clear();
  });

  const CLAIM_ID = "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a";
  const WS = "workspace-1";

  function buildDraftClaim(): ClaimForm {
    return {
      object_id: CLAIM_ID,
      object_kind: "claim_form",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW,
      created_by: "user_action",
      governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
      claim_kind: "constraint",
      scope_class: ScopeClass.PROJECT,
      enforcement_level: "strict",
      origin_tier: "user_explicit",
      precedence_basis: "authority",
      proposition_digest: "Use pnpm for workspace commands.",
      evidence_refs: [],
      source_object_refs: [],
      workspace_id: WS,
      claim_status: ClaimLifecycleState.DRAFT
    } as ClaimForm;
  }

  it("rolls back BOTH the audit-event row and the claim_status mutation when the mutate throws", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);

    const workspaceRepo = new SqliteWorkspaceRepo(database);
    await workspaceRepo.create({
      workspace_id: WS,
      name: "workspace one",
      root_path: "/tmp/ws1",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const eventLogRepo = new SqliteEventLogRepo(database);
    const claimFormRepo = new SqliteClaimFormRepo(database);
    claimFormRepo.create(buildDraftClaim());

    const eventPublisher = new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: vi.fn(async () => undefined) },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    // The injected failure: updateStatusSync throws from INSIDE the
    // appendManyWithMutation mutate callback. The append of the
    // lifecycle event and the composed audit event already ran in the
    // open transaction; the throw must roll the whole transaction back.
    const failingClaimFormRepo = new Proxy(claimFormRepo, {
      get(target, prop, receiver) {
        if (prop === "updateStatusSync") {
          return () => {
            throw new Error("synthetic claim_status mutation failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });

    const claimService = new ClaimService({
      claimFormRepo: failingClaimFormRepo as unknown as SqliteClaimFormRepo,
      eventLogRepo,
      runtimeNotifier: { notifyEntry: vi.fn() },
      eventPublisher,
      now: () => FIXED_NOW
    });

    const auditEventsSink: EventLogEntry[] = [];
    await expect(
      claimService.transitionLifecycle(
        CLAIM_ID,
        ClaimLifecycleState.ACTIVE,
        "soul_resolve_confirm",
        "user",
        {
          skipSlotElection: true,
          additionalEventInputs: [
            {
              event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED,
              entity_type: "claim_form",
              entity_id: CLAIM_ID,
              workspace_id: WS,
              run_id: null,
              caused_by: "user",
              payload_json: {
                target_object_id: CLAIM_ID,
                target_object_kind: "claim_form",
                workspace_id: WS,
                run_id: null,
                resolution: "confirm",
                policy: null,
                delivery_id: "delivery-1",
                agent_target: "codex",
                activated_claim_id: CLAIM_ID,
                obligation_id: null,
                correction: null,
                reason: null,
                resolved_at: FIXED_NOW
              }
            }
          ],
          additionalEventsSink: auditEventsSink
        }
      )
    ).rejects.toThrow("synthetic claim_status mutation failure");

    // The audit event row must NOT have persisted.
    const auditRows = database.connection
      .prepare(
        `SELECT COUNT(*) AS n FROM event_log WHERE event_type = ?`
      )
      .get(GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED) as { n: number };
    expect(auditRows.n).toBe(0);

    // The lifecycle-change event row must NOT have persisted either.
    const lifecycleRows = database.connection
      .prepare(`SELECT COUNT(*) AS n FROM event_log WHERE event_type = ?`)
      .get("soul.claim.lifecycle_changed") as { n: number };
    expect(lifecycleRows.n).toBe(0);

    // The claim_status mutation must NOT have persisted — still DRAFT.
    // This is the durable atomicity proof: the event_log rows and the
    // claim_status row both vanish on rollback. (additionalEventsSink is
    // an in-memory array populated before the throw inside the same
    // callback; it is intentionally not asserted — the caller never reads
    // it on a thrown transition, and only durable state is transactional.)
    const reloaded = await claimFormRepo.findById(CLAIM_ID);
    expect(reloaded?.claim_status).toBe(ClaimLifecycleState.DRAFT);
  });
});
