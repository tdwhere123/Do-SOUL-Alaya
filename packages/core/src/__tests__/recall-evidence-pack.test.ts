import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  type EventLogEntry,
  type MemoryEntry,
  type RecallPolicy,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { RecallService, type RecallServiceDependencies } from "../recall-service.js";
import { buildRecallEvidencePack } from "../recall-evidence-pack.js";

interface RecallFixture {
  readonly fixture_id: string;
  readonly query: string;
  readonly memories: readonly MemoryEntry[];
  readonly expected_object_ids: readonly string[];
}

describe("recall evidence pack", () => {
  it("records fixture-level recall evidence and metrics without model-quality claims", async () => {
    const packs = [];

    for (const fixture of createRecallFixtures()) {
      const result = await recallFixture(fixture);
      packs.push(
        buildRecallEvidencePack({
          fixture_id: fixture.fixture_id,
          query: fixture.query,
          result,
          expected_object_ids: fixture.expected_object_ids,
          delivery: {
            delivery_id: `delivery-${fixture.fixture_id}`,
            delivered_object_ids: result.candidates.map((candidate) => candidate.object_id)
          },
          usage: {
            delivery_id: `delivery-${fixture.fixture_id}`,
            used_object_ids: fixture.expected_object_ids
          }
        })
      );
    }

    expect(packs.map((pack) => pack.fixture_id)).toEqual([
      "exact_fact",
      "current_state_update",
      "negative_query",
      "relation_query",
      "broad_thematic_recall",
      "chinese_preference_constraint"
    ]);
    expect(packs.every((pack) => pack.metrics.factual_expected_hit)).toBe(true);
    expect(packs.find((pack) => pack.fixture_id === "negative_query")?.metrics).toMatchObject({
      selected_count: 0,
      coverage: 1,
      token_footprint: 0
    });
    expect(packs.find((pack) => pack.fixture_id === "relation_query")?.candidates[0]).toMatchObject({
      object_id: "relation-router-storage",
      source_channels: expect.arrayContaining(["graph_support"])
    });
    expect(packs.find((pack) => pack.fixture_id === "broad_thematic_recall")?.metrics).toMatchObject({
      expected_hit_count: 2,
      coverage: 1
    });
    expect(packs.find((pack) => pack.fixture_id === "chinese_preference_constraint")?.selected_object_ids).toContain(
      "zh-rtk-constraint"
    );
  });
});

async function recallFixture(fixture: RecallFixture) {
  const dependencies = createDependencies(fixture.memories);
  const service = new RecallService(dependencies);
  const policy = createFixturePolicy(service, fixture.query);

  return await service.recall({
    taskSurface: createTaskSurface(fixture.query),
    workspaceId: "workspace-1",
    strategy: "analyze",
    policyOverride: policy,
    hostContext: { tokenizer_hint: "approx_chars_per_token" }
  });
}

function createDependencies(memories: readonly MemoryEntry[]): RecallServiceDependencies {
  return {
    now: () => "2026-05-13T00:00:00.000Z",
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: vi.fn(async (_workspaceId, tier) =>
        memories.filter((memory) => tier === undefined || memory.storage_tier === tier)
      ),
      findByDimension: vi.fn(async (_workspaceId, dimension) =>
        memories.filter((memory) => memory.dimension === dimension)
      ),
      findByScopeClass: vi.fn(async (_workspaceId, scopeClass) =>
        memories.filter((memory) => memory.scope_class === scopeClass)
      ),
      searchByKeywordWithinObjectIds: vi.fn(async (_workspaceId, queryText, limit, objectIds) => {
        const queryTokens = tokenize(queryText);
        return memories
          .filter((memory) => objectIds.includes(memory.object_id))
          .map((memory) => ({
            object_id: memory.object_id,
            normalized_rank: computeLexicalRank(queryTokens, memory)
          }))
          .filter((match) => match.normalized_rank > 0)
          .sort((left, right) => right.normalized_rank - left.normalized_rank)
          .slice(0, limit);
      })
    },
    slotRepo: {
      findByWorkspace: vi.fn(async () => [])
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
        event_id: "event-1",
        created_at: "2026-05-13T00:00:00.000Z",
        revision: 0,
        ...entry
      })),
      queryByEntity: vi.fn(async () => [])
    },
    graphSupportPort: {
      countInboundSupports: vi.fn(async (memoryId) =>
        memoryId === "relation-router-storage" ? 3 : 0
      )
    }
  };
}

function createFixturePolicy(service: RecallService, query: string): RecallPolicy {
  const base = service.buildDefaultPolicy("analyze", createTaskSurface(query).runtime_id);
  return {
    ...base,
    coarse_filter: {
      deterministic_match: {
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: 0,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: true,
        max_supplement: 8,
        embedding_enabled: false
      }
    },
    fine_assessment: {
      budgets: {
        max_entries: 5,
        max_total_tokens: 800,
        per_dimension_limits: null
      },
      conflict_awareness: true
    }
  };
}

function createRecallFixtures(): readonly RecallFixture[] {
  return [
    {
      fixture_id: "exact_fact",
      query: "project codename aurora",
      memories: [
        createMemoryEntry({
          object_id: "exact-codename",
          dimension: MemoryDimension.FACT,
          content: "Project codename is Aurora.",
          domain_tags: ["project", "codename"]
        })
      ],
      expected_object_ids: ["exact-codename"]
    },
    {
      fixture_id: "current_state_update",
      query: "current deploy status",
      memories: [
        createMemoryEntry({
          object_id: "status-old",
          dimension: MemoryDimension.FACT,
          content: "Deploy status was blocked yesterday.",
          activation_score: 0.2,
          updated_at: "2026-05-12T00:00:00.000Z"
        }),
        createMemoryEntry({
          object_id: "status-current",
          dimension: MemoryDimension.FACT,
          content: "Current deploy status is green.",
          activation_score: 0.9,
          updated_at: "2026-05-13T00:00:00.000Z"
        })
      ],
      expected_object_ids: ["status-current"]
    },
    {
      fixture_id: "negative_query",
      query: "missing payments backlog",
      memories: [
        createMemoryEntry({
          object_id: "unrelated-procedure",
          dimension: MemoryDimension.PROCEDURE,
          content: "Use rtk pnpm build for build verification."
        })
      ],
      expected_object_ids: []
    },
    {
      fixture_id: "relation_query",
      query: "router storage relation",
      memories: [
        createMemoryEntry({
          object_id: "relation-router-storage",
          dimension: MemoryDimension.FACT,
          content: "The router depends on storage relation metadata for graph recall.",
          domain_tags: ["router", "storage"]
        })
      ],
      expected_object_ids: ["relation-router-storage"]
    },
    {
      fixture_id: "broad_thematic_recall",
      query: "memory quality",
      memories: [
        createMemoryEntry({
          object_id: "theme-evidence-density",
          dimension: MemoryDimension.FACT,
          content: "Memory quality evaluation tracks evidence density."
        }),
        createMemoryEntry({
          object_id: "theme-redundancy",
          dimension: MemoryDimension.FACT,
          content: "Memory quality evaluation also tracks redundancy."
        })
      ],
      expected_object_ids: ["theme-evidence-density", "theme-redundancy"]
    },
    {
      fixture_id: "chinese_preference_constraint",
      query: "中文 rtk 约束",
      memories: [
        createMemoryEntry({
          object_id: "zh-rtk-constraint",
          dimension: MemoryDimension.CONSTRAINT,
          content: "中文偏好/约束：必须用 rtk 包裹仓库命令。",
          domain_tags: ["中文", "rtk"]
        })
      ],
      expected_object_ids: ["zh-rtk-constraint"]
    }
  ];
}

function createTaskSurface(query: string): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-13T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: query,
    context_refs: []
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Memory content.",
    domain_tags: ["memory"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function computeLexicalRank(queryTokens: readonly string[], memory: MemoryEntry): number {
  const haystack = `${memory.content} ${memory.domain_tags.join(" ")}`.toLowerCase();
  const hits = queryTokens.filter((token) => haystack.includes(token.toLowerCase())).length;
  return queryTokens.length === 0 ? 0 : hits / queryTokens.length;
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
