import {
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackSourceHash,
  formatGardenSourceTurnFallbackV2SourceHash,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import { createFieldBackedRecallService } from
  "../fixtures/keyword-field-fixture.js";
import {
  selectExpansionSeedDrafts,
  selectPreferredExpansionSeedEntries
} from "../../../recall/coarse-filter/coarse-candidates.js";
import {
  buildDirectEvidencePseudoMemoryEntry,
  isDirectRecallEvidence
} from "../../../recall/coarse-filter/evidence/direct-evidence-candidate.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-8factor-test-fixtures.js";
import { qualifyEvidence } from "./qualified-evidence-test-fixture.js";

const EVIDENCE_ID = "00000000-0000-4000-8000-000000000101";
const SECOND_EVIDENCE_ID = "00000000-0000-4000-8000-000000000102";
describe("direct evidence recall candidates", () => {
  it("keeps verified User support for an owner-only qualified v2 hit", async () => {
    const fullExcerpt = `The assistant recommended the blue option. ${"Detailed explanation. ".repeat(90)}tail answer`;
    const evidence = createEvidenceCapsule({
      excerpt: fullExcerpt,
      source_hash: formatGardenSourceTurnFallbackV2SourceHash("b".repeat(64))
    });
    const score = vi.fn(
      async (_query: string, _passages: readonly string[]) => [0.9]
    );
    const { dependencies, countInboundSupports } = createDependencies([]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      answerRerankService: { score },
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: undefined,
        findBoundEvidenceRefs: vi.fn(async () => []),
        findByIds: vi.fn(async () => [])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(evidence, true)])
      }
    });
    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
    });
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        object_id: EVIDENCE_ID,
        object_kind: "evidence_capsule",
        content_preview: expect.stringContaining("blue option")
      })
    ]));
    const candidate = result.candidates.find((item) => item.object_id === EVIDENCE_ID);
    expect(candidate?.source_channels).toContain("evidence_fts_direct");
    expect(candidate?.content_preview.length).toBeLessThanOrEqual(601);
    expect(candidate?.content_preview.endsWith("…")).toBe(true);
    expect(candidate?.content_preview).not.toContain("tail answer");
    expect(candidate?.token_estimate).toBeLessThan(200);
    expect(score.mock.calls[0]?.[1]).toEqual([candidate?.content_preview]);
    expect(candidate?.score_factors?.graph_support ?? 0).toBe(0);
    expect(candidate?.score_factors?.path_plasticity ?? 0).toBe(0);
    expect(countInboundSupports).not.toHaveBeenCalledWith(EVIDENCE_ID);
    const observation = result.diagnostics?.candidates.find((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )?.answer_features?.answer_support_observations?.[0];
    expect(result.diagnostics?.candidates.find((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )?.selector_observation?.evidence.source_role).toBe("user");
    expect(observation).toMatchObject({
      source_identity: `evidence_ref:${EVIDENCE_ID}`,
      support_identity: null,
      projection_kind: "turn_projection",
      provenance_status: "verified_user_turn",
      behavior_eligible: false
    });
  });

  it("admits a qualified fact-key projection as direct evidence", async () => {
    const evidence = createEvidenceCapsule({
      excerpt: "I use Atlas for research.",
      semantic_anchor: {
        topic: "research tool",
        keywords: ["Atlas", "research"],
        summary: "I use Atlas for research."
      }
    });
    const { dependencies } = createDependencies([]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => []),
        findBoundEvidenceRefs: vi.fn(async () => []),
        findByIds: vi.fn(async () => [])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [{
          object_id: EVIDENCE_ID,
          normalized_rank: 0.92,
          matched_projection: {
            projection_id: 1,
            projection_kind: "fact_key" as const
          }
        }]),
        findRecallQualifiedByIds: vi.fn(async () => [{
          ...qualifyEvidence(evidence, true),
          matched_projection: {
            projection_id: 1,
            projection_kind: "fact_key" as const,
            content: "I use Atlas for research."
          },
          matched_fact_key_forms: [],
          matched_fact_frame: undefined
        }])
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which research tool do I use?"),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
    });

    const candidate = result.candidates.find((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    );
    expect(candidate?.content_preview).toContain("I use Atlas for research.");
    expect(candidate?.source_channels).toContain("evidence_fts_direct");
    expect(result.diagnostics?.candidates.find((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )?.answer_features?.answer_support_observations?.[0]).toMatchObject({
      projection_kind: "turn_projection",
      provenance_status: "verified_user_turn"
    });
  });

  it("does not duplicate evidence already bound to a memory entry", async () => {
    const memory = createMemoryEntry({
      object_id: "memory-bound",
      evidence_refs: [EVIDENCE_ID],
      content: "The assistant recommended the blue option."
    });
    const { dependencies } = createDependencies([memory]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => [memory])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule({
          physical_anchor: {
            file_path: null,
            line_range: null,
            symbol_name: null,
            artifact_ref: "conversation:turn-1:assistant"
          }
        }))])
      }
    });
    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
    });
    expect(result.candidates.filter((item) => item.object_id === EVIDENCE_ID)).toEqual([]);
    expect(result.candidates.filter((item) => item.object_id === "memory-bound")).toHaveLength(1);
  });

  it("routes bound source-turn evidence through the existing memory lane", async () => {
    const memory = createMemoryEntry({
      object_id: "memory-bound",
      evidence_refs: [EVIDENCE_ID]
    });
    const findByEvidenceRefs = vi.fn(async () => [memory]);
    const { dependencies } = createDependencies([memory]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs,
        findBoundEvidenceRefs: vi.fn(async () => [EVIDENCE_ID])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule())])
      }
    });
    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });
    expect(result.candidates.filter((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )).toEqual([]);
    expect(findByEvidenceRefs).toHaveBeenCalledWith(
      "workspace-1",
      expect.arrayContaining([EVIDENCE_ID])
    );
    expect(result.candidates.find((item) =>
      item.object_id === memory.object_id
    )?.source_channels).toContain("evidence_fts");
    expect(result.diagnostics?.candidates.find((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )?.answer_features?.answer_support_observations).toBeUndefined();
  });

  it("fails closed when the complete binding authority port is unavailable", async () => {
    const { dependencies } = createDependencies([]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: undefined,
        findBoundEvidenceRefs: undefined
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule())])
      }
    });
    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });
    expect(result.candidates).toEqual([]);
  });

  it("fails closed for ordinary unbound evidence without the source-turn authority prefix", async () => {
    const { dependencies } = createDependencies([]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => []),
        findBoundEvidenceRefs: vi.fn(async () => []),
        findByIds: vi.fn(async () => [])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule({
          physical_anchor: {
            file_path: null,
            line_range: null,
            symbol_name: null,
            artifact_ref: "conversation:turn-1:assistant"
          }
        }))])
      }
    });
    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });
    expect(result.candidates).toEqual([]);
  });

  it("keeps unresolved hydration hits on the memory lane", async () => {
    const memory = createMemoryEntry({
      object_id: "memory-partial-hydration",
      evidence_refs: [SECOND_EVIDENCE_ID]
    });
    const { dependencies } = createDependencies([memory]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => [memory]),
        findBoundEvidenceRefs: vi.fn(async () => []),
        findByIds: vi.fn(async () => [])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 },
          { object_id: SECOND_EVIDENCE_ID, normalized_rank: 0.9 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule())])
      }
    });
    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates.find((item) =>
      item.object_id === memory.object_id
    )?.source_channels).toContain("evidence_fts");
  });

  it("falls back to the memory lane when evidence hydration fails", async () => {
    const memory = createMemoryEntry({
      object_id: "memory-hydration-error",
      evidence_refs: [EVIDENCE_ID]
    });
    const { dependencies } = createDependencies([memory]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => [memory])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => {
          throw new Error("evidence hydration unavailable");
        })
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates.find((item) =>
      item.object_id === memory.object_id
    )?.source_channels).toContain("evidence_fts");
  });

  it("fails closed for a direct evidence id that collides with a workspace memory id", async () => {
    const collidingMemory = createMemoryEntry({ object_id: EVIDENCE_ID });
    const { dependencies } = createDependencies([collidingMemory]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => []),
        findBoundEvidenceRefs: vi.fn(async () => []),
        findByIds: vi.fn(async () => [collidingMemory])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule())])
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates.some((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )).toBe(false);
  });

  it.each([
    { label: "dormant", lookup: "result", overrides: { lifecycle_state: "dormant" as const } },
    { label: "tombstoned", lookup: "result", overrides: { retention_state: "tombstoned" as const } },
    { label: "cold tier", lookup: "result", overrides: { storage_tier: "cold" as const } },
    { label: "missing collision lookup", lookup: "missing", overrides: {} },
    { label: "failed collision lookup", lookup: "error", overrides: {} }
  ])("fails closed for $label", async ({ lookup, overrides }) => {
    const collidingMemory = createMemoryEntry({
      object_id: EVIDENCE_ID,
      ...overrides
    });
    const { dependencies } = createDependencies([]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => []),
        findBoundEvidenceRefs: vi.fn(async () => []),
        findByIds: lookup === "missing" ? undefined : vi.fn(async () => {
          if (lookup === "error") throw new Error("memory id lookup unavailable");
          return [collidingMemory];
        })
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule())])
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates).toEqual([]);
  });

  it("keeps dormant bound evidence on the memory lane without a direct candidate", async () => {
    const memory = createMemoryEntry({
      object_id: "memory-dormant-evidence",
      evidence_refs: [EVIDENCE_ID]
    });
    const { dependencies } = createDependencies([memory]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => [memory])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule({
          lifecycle_state: "dormant"
        }))])
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates.some((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )).toBe(false);
    expect(result.candidates.find((item) =>
      item.object_id === memory.object_id
    )?.source_channels).toContain("evidence_fts");
  });

  it.each([
    { lifecycle_state: "dormant" as const },
    { evidence_health_state: "questionable" as const },
    { evidence_kind: "user_statement" as const },
    { created_by: "external_import" },
    { source_hash: "sha256:unverified" }
  ])("rejects ineligible direct evidence: $evidence_kind $evidence_health_state $lifecycle_state", async (override) => {
    const { dependencies } = createDependencies([]);
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => []),
        findBoundEvidenceRefs: vi.fn(async () => [])
      },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: EVIDENCE_ID, normalized_rank: 0.95 }
        ]),
        findRecallQualifiedByIds: vi.fn(async () => [qualifyEvidence(createEvidenceCapsule(override))])
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which color did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.candidates).toEqual([]);
  });

  it("does not expose direct evidence as a graph, path, or content-expansion seed", () => {
    const evidence = createEvidenceCapsule({
      physical_anchor: {
        file_path: null,
        line_range: null,
        symbol_name: null,
        artifact_ref: "conversation:turn-1:assistant"
      }
    });
    const entry = buildDirectEvidencePseudoMemoryEntry(evidence, 0.95);
    const drafts = new Map([[
      evidence.object_id,
      {
        entry,
        objectKind: "evidence_capsule" as const,
        admissionPlanes: ["lexical" as const],
        firstAdmissionPlane: "lexical" as const,
        sourceChannels: ["evidence_fts_direct"],
        structuralScore: 0.95,
        pathExpansionSources: []
      }
    ]]);

    expect(isDirectRecallEvidence(evidence, "workspace-1")).toBe(false);
    expect(selectExpansionSeedDrafts(drafts)).toEqual([]);
    expect(selectPreferredExpansionSeedEntries(drafts)).toEqual([]);
  });
});

function createEvidenceCapsule(
  overrides: Partial<EvidenceCapsule> = {}
): Readonly<EvidenceCapsule> {
  return Object.freeze({
    object_id: EVIDENCE_ID,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: {
      topic: "color recommendation",
      keywords: ["color", "blue", "recommend"],
      summary: "The assistant recommended the blue option."
    },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: formatGardenSourceTurnFallbackArtifactRef("turn-1:assistant")
    },
    evidence_health_state: "verified",
    gist: "The assistant recommended the blue option.",
    excerpt: "The assistant recommended the blue option because it was more durable.",
    source_hash: formatGardenSourceTurnFallbackSourceHash("a".repeat(64)),
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: "surface-1",
    ...overrides
  });
}
