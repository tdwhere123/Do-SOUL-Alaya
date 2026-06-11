import { describe, expect, it, vi } from "vitest";
import {
  DYNAMICS_CONSTANTS,
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  StorageTier,
  type EventLogEntry,
  type EvidenceCapsule,
  type KarmaEvent,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { DynamicsService, type DynamicsServiceDependencies } from "../dynamics-service.js";
import { EvidenceService } from "../memory/evidence-service.js";
import { ConflictDetectionService } from "../governance/conflict-detection-service.js";
import type { PathMintOutcome } from "../path-graph/path-relation-proposal-service.js";

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-target",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "user",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "content",
    domain_tags: ["workflow"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.4,
    retention_score: 0.4,
    manifestation_state: "hint",
    retention_state: "working",
    decay_profile: "normal",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

function createDynamicsHarness(memoryEntries: readonly MemoryEntry[]): {
  readonly dynamics: DynamicsService;
  readonly entriesById: Map<string, MemoryEntry>;
  readonly karmaEvents: KarmaEvent[];
} {
  const entriesById = new Map(memoryEntries.map((entry) => [entry.object_id, { ...entry }]));
  const karmaEvents: KarmaEvent[] = [];
  const appendedEvents: EventLogEntry[] = [];

  const dependencies: DynamicsServiceDependencies = {
    now: () => "2026-03-23T00:00:00.000Z",
    generateEventId: (() => {
      let counter = 0;
      return () => `event-${(counter += 1)}`;
    })(),
    memoryRepo: {
      findById: vi.fn(async (objectId: string) => {
        const found = entriesById.get(objectId);
        return found === undefined ? null : Object.freeze({ ...found });
      }),
      findByWorkspaceId: vi.fn(async () => Object.freeze([])),
      updateDynamics: vi.fn(async (objectId, fields, updatedAt) => {
        const existing = entriesById.get(objectId);
        if (existing === undefined) {
          throw new Error(`missing entry ${objectId}`);
        }
        const updated: MemoryEntry = {
          ...existing,
          activation_score: fields.activation_score,
          retention_score: fields.retention_score,
          manifestation_state: fields.manifestation_state,
          last_used_at: fields.last_used_at ?? existing.last_used_at,
          last_hit_at: fields.last_hit_at ?? existing.last_hit_at,
          reinforcement_count: fields.reinforcement_count ?? existing.reinforcement_count,
          contradiction_count: fields.contradiction_count ?? existing.contradiction_count,
          superseded_by: fields.superseded_by ?? existing.superseded_by,
          updated_at: updatedAt
        };
        entriesById.set(objectId, updated);
        return Object.freeze({ ...updated });
      })
    },
    karmaEventRepo: {
      create: vi.fn(async (event) => {
        const frozen = Object.freeze({ ...event });
        karmaEvents.push(frozen);
        return frozen;
      }),
      sumByObjectId: vi.fn(async (objectId) =>
        karmaEvents.filter((event) => event.object_id === objectId).reduce((sum, e) => sum + e.amount, 0)
      ),
      sumByObjectIds: vi.fn(async (objectIds) => {
        const totals: Record<string, number> = {};
        for (const id of objectIds) {
          totals[id] = karmaEvents.filter((e) => e.object_id === id).reduce((sum, e) => sum + e.amount, 0);
        }
        return Object.freeze(totals);
      }),
      findByObjectId: vi.fn(async (objectId) =>
        karmaEvents.filter((e) => e.object_id === objectId).map((e) => Object.freeze({ ...e }))
      )
    },
    eventLogRepo: {
      append: vi.fn(async (entry) => {
        const created: EventLogEntry = {
          event_id: `evt-${appendedEvents.length + 1}`,
          created_at: "2026-03-23T00:00:00.000Z",
          revision: 0,
          ...entry
        };
        appendedEvents.push(created);
        return created;
      }),
      queryByEntity: vi.fn(async () => [])
    },
    runtimeNotifier: { notifyEntry: vi.fn(async () => {}) }
  };

  return {
    dynamics: new DynamicsService(dependencies),
    entriesById,
    karmaEvents
  };
}

describe("karma producers (reuse_gain / evidence_gain / supersede_penalty)", () => {
  describe("reuse_gain", () => {
    it("emits reuse_gain with the canonical karma constant and bumps reinforcement_count", async () => {
      const { dynamics, entriesById, karmaEvents } = createDynamicsHarness([createMemoryEntry()]);

      await dynamics.emitKarmaEvent({
        kind: "reuse_gain",
        objectId: "memory-target",
        workspaceId: "workspace-1"
      });

      expect(karmaEvents).toHaveLength(1);
      expect(karmaEvents[0]!.kind).toBe("reuse_gain");
      expect(karmaEvents[0]!.amount).toBe(DYNAMICS_CONSTANTS.karma.reuse_gain);
      expect(karmaEvents[0]!.object_id).toBe("memory-target");
      expect(karmaEvents[0]!.workspace_id).toBe("workspace-1");
      expect(entriesById.get("memory-target")?.reinforcement_count).toBe(1);
      expect(entriesById.get("memory-target")?.last_hit_at).toBe("2026-03-23T00:00:00.000Z");
    });
  });

  describe("evidence_gain", () => {
    it("EvidenceService fires evidence_gain on questionable -> verified transition for each bound memory", async () => {
      const emitKarmaEvent = vi.fn(async () => {});
      const findMemoriesByEvidenceRef = vi.fn(async () => [
        { object_id: "memory-a" },
        { object_id: "memory-b" }
      ]);
      const evidenceCapsule: EvidenceCapsule = {
        object_id: "evidence-1",
        object_kind: "evidence_capsule",
        schema_version: 1,
        lifecycle_state: "active",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
        created_by: "user",
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        evidence_kind: "user_statement",
        semantic_anchor: { topic: "test", keywords: ["t"], summary: "summary" },
        event_anchor: null,
        physical_anchor: null,
        evidence_health_state: "questionable",
        gist: "gist",
        excerpt: "ex",
        source_hash: null
      };
      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: {
          create: vi.fn(),
          findById: vi.fn(async () => Object.freeze({ ...evidenceCapsule })),
          findByRunId: vi.fn(),
          findByWorkspaceId: vi.fn(),
          findByHealth: vi.fn(),
          updateHealth: vi.fn(async (_objectId, health, updatedAt) =>
            Object.freeze({
              ...evidenceCapsule,
              evidence_health_state: health,
              updated_at: updatedAt
            })
          )
        },
        eventLogRepo: {
          append: vi.fn(async (entry) => ({
            event_id: "evt-1",
            created_at: "2026-03-23T00:00:00.000Z",
            revision: 0,
            ...entry
          }))
        },
        runtimeNotifier: { notifyEntry: vi.fn(async () => {}) },
        karmaEmitter: { emitKarmaEvent },
        memoryRefLookup: { findMemoriesByEvidenceRef }
      });

      await evidenceService.transitionHealth(
        "evidence-1",
        "verified",
        "rechecked-source",
        "user"
      );

      expect(findMemoriesByEvidenceRef).toHaveBeenCalledWith("evidence-1", "workspace-1");
      expect(emitKarmaEvent).toHaveBeenCalledTimes(2);
      expect(emitKarmaEvent).toHaveBeenNthCalledWith(1, {
        kind: "evidence_gain",
        objectId: "memory-a",
        workspaceId: "workspace-1"
      });
      expect(emitKarmaEvent).toHaveBeenNthCalledWith(2, {
        kind: "evidence_gain",
        objectId: "memory-b",
        workspaceId: "workspace-1"
      });
    });

    it("EvidenceService skips evidence_gain when transitioning to non-verified state", async () => {
      const emitKarmaEvent = vi.fn(async () => {});
      const findMemoriesByEvidenceRef = vi.fn(async () => [{ object_id: "memory-a" }]);
      const baseCapsule: EvidenceCapsule = {
        object_id: "evidence-1",
        object_kind: "evidence_capsule",
        schema_version: 1,
        lifecycle_state: "active",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
        created_by: "user",
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        evidence_kind: "user_statement",
        semantic_anchor: { topic: "test", keywords: ["t"], summary: "summary" },
        event_anchor: null,
        physical_anchor: null,
        evidence_health_state: "verified",
        gist: "g",
        excerpt: "e",
        source_hash: null
      };
      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: {
          create: vi.fn(),
          findById: vi.fn(async () => Object.freeze({ ...baseCapsule })),
          findByRunId: vi.fn(),
          findByWorkspaceId: vi.fn(),
          findByHealth: vi.fn(),
          updateHealth: vi.fn(async (_objectId, health, updatedAt) =>
            Object.freeze({ ...baseCapsule, evidence_health_state: health, updated_at: updatedAt })
          )
        },
        eventLogRepo: {
          append: vi.fn(async (entry) => ({
            event_id: "evt-1",
            created_at: "2026-03-23T00:00:00.000Z",
            revision: 0,
            ...entry
          }))
        },
        runtimeNotifier: { notifyEntry: vi.fn(async () => {}) },
        karmaEmitter: { emitKarmaEvent },
        memoryRefLookup: { findMemoriesByEvidenceRef }
      });

      await evidenceService.transitionHealth(
        "evidence-1",
        "questionable",
        "doubt-raised",
        "user"
      );

      expect(emitKarmaEvent).not.toHaveBeenCalled();
    });
  });

  describe("supersede_penalty", () => {
    it("ConflictDetectionService fires supersede_penalty on the LLM-verdict contradicts edge", async () => {
      type KarmaInput = {
        readonly kind: string;
        readonly objectId: string;
        readonly workspaceId: string;
        readonly runId?: string | null;
      };
      const emitKarmaEvent = vi.fn(async (_input: KarmaInput) => {});
      // tag overlap {database, alpha} vs {database, beta} = 1/3 ≈ 0.333:
      // below the rule threshold (0.35) so only the system-computed LLM
      // verdict fires — the trust tier that carries the karma penalty.
      const existing = createMemoryEntry({
        object_id: "memory-existing",
        content: "Use PostgreSQL for primary durable storage.",
        domain_tags: ["database", "alpha"]
      });

      const service = new ConflictDetectionService({
        memoryRepo: {
          findByDimension: async () => [Object.freeze({ ...existing })],
          findBySharedDomainTags: async () => []
        },
        pathCandidatePort: {
          submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied")
        },
        llmPort: { classifyPair: vi.fn(async () => "contradicts" as const) },
        karmaEmitter: { emitKarmaEvent }
      });

      await service.detectAndLinkConflicts({
        newMemoryId: "memory-new",
        newMemoryDimension: MemoryDimension.FACT,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "Adopt MongoDB across the cluster.",
        newMemoryDomainTags: ["database", "beta"],
        workspaceId: "workspace-1",
        runId: "run-1"
      });

      expect(emitKarmaEvent).toHaveBeenCalled();
      const contradictsCalls = emitKarmaEvent.mock.calls.filter(
        ([arg]) => arg.kind === "supersede_penalty"
      );
      expect(contradictsCalls.length).toBeGreaterThan(0);
      expect(contradictsCalls[0]?.[0]).toEqual({
        kind: "supersede_penalty",
        objectId: "memory-existing",
        workspaceId: "workspace-1",
        runId: "run-1"
      });
    });

    it("ConflictDetectionService does NOT fire supersede_penalty on a rule-path contradicts hit", async () => {
      type KarmaInput = {
        readonly kind: string;
        readonly objectId: string;
        readonly workspaceId: string;
      };
      const emitKarmaEvent = vi.fn(async (_input: KarmaInput) => {});
      const submitCandidate = vi.fn(async (): Promise<PathMintOutcome> => "applied");
      // high tag overlap + low token overlap → rule path fires contradicts,
      // but the rule verdict is agent-controllable, so no karma penalty.
      const existing = createMemoryEntry({
        object_id: "memory-existing",
        content: "Use PostgreSQL for primary durable storage.",
        domain_tags: ["database", "stack-choice"]
      });

      const service = new ConflictDetectionService({
        memoryRepo: {
          findByDimension: async () => [Object.freeze({ ...existing })],
          findBySharedDomainTags: async () => [Object.freeze({ ...existing })]
        },
        pathCandidatePort: { submitCandidate },
        karmaEmitter: { emitKarmaEvent }
      });

      await service.detectAndLinkConflicts({
        newMemoryId: "memory-new",
        newMemoryDimension: MemoryDimension.FACT,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "Adopt MongoDB across the cluster.",
        newMemoryDomainTags: ["database", "stack-choice"],
        workspaceId: "workspace-1",
        runId: "run-1"
      });

      const ruleContradicts = submitCandidate.mock.calls.filter(
        (call: any[]) => call[0].relationKind === "contradicts"
      );
      expect(ruleContradicts.length).toBeGreaterThan(0);
      expect(emitKarmaEvent).not.toHaveBeenCalled();
    });

    it("ConflictDetectionService does not emit supersede_penalty for incompatible_with edges", async () => {
      const emitKarmaEvent = vi.fn(async () => {});
      const submitCandidate = vi.fn(
        async (input: { readonly relationKind: string }): Promise<PathMintOutcome> => {
          expect(input.relationKind).toBe("incompatible_with");
          return "applied";
        }
      );
      const existing = createMemoryEntry({
        object_id: "memory-existing",
        scope_class: ScopeClass.GLOBAL_CORE,
        content: "Cats purr.",
        domain_tags: ["animal"]
      });

      const service = new ConflictDetectionService({
        memoryRepo: {
          findByDimension: async () => [],
          findBySharedDomainTags: async () => [Object.freeze({ ...existing })]
        },
        pathCandidatePort: { submitCandidate },
        karmaEmitter: { emitKarmaEvent }
      });

      await service.detectAndLinkConflicts({
        newMemoryId: "memory-new",
        newMemoryDimension: MemoryDimension.PREFERENCE,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "Dogs bark.",
        newMemoryDomainTags: ["animal"],
        workspaceId: "workspace-1",
        runId: "run-1"
      });

      expect(emitKarmaEvent).not.toHaveBeenCalled();
    });
  });
});
