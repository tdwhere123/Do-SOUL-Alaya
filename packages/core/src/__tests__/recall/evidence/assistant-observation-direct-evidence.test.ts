import {
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackV2SourceHash,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import type {
  RecallEvidenceSearchMatch,
  RecallServiceMemoryRepoPort,
  RecallServiceEvidenceSearchPort
} from "../../../recall/runtime/recall-service-ports.js";
import {
  createDependencies,
  createTaskSurface
} from "../recall-8factor-test-fixtures.js";
import {
  fieldSearchFromScalar,
  keywordFieldResult,
  keywordSearchMethods
} from "../fixtures/keyword-field-fixture.js";

const EVIDENCE_ID = "00000000-0000-4000-8000-000000000101";

describe("Assistant observation direct evidence", () => {
  it("keeps the evidence owner while delivering only the matched Assistant observation without User authority", async () => {
    const userQuestion = "Which backpack should I use for a rainy commute?";
    const recommendation = "Choose the moss-green TrailShell pack; its roll-top keeps a laptop dry in rain. It also dries quickly overnight.";
    const evidence = createEvidenceCapsule({
      gist: `User: ${userQuestion}\nAssistant: ${recommendation}`,
      excerpt: userQuestion,
      source_hash: formatGardenSourceTurnFallbackV2SourceHash("c".repeat(64))
    });
    const qualifiedAssistantObservation = Object.freeze({
      capsule: evidence,
      verified_user_projection: true,
      matched_projection: Object.freeze({
        projection_id: 1,
        projection_kind: "assistant_observation" as const,
        content: recommendation
      })
    });
    const findRecallQualifiedByIds = vi.fn(async (
      _workspaceId: string,
      _matches: readonly RecallEvidenceSearchMatch[]
    ) => [qualifiedAssistantObservation]);
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => []),
        findBoundEvidenceRefs: vi.fn(async () => []),
        findByIds: vi.fn(async () => [])
      },
      evidenceSearchPort: {
        ...keywordSearchMethods(vi.fn(async () => [
          {
            object_id: EVIDENCE_ID,
            normalized_rank: 0.95,
            matched_projection: {
              projection_id: 1,
              projection_kind: "assistant_observation" as const
            }
          }
        ])),
        findRecallQualifiedByIds
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which backpack did you recommend for a rainy commute?"),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
    });

    const candidate = result.candidates.find((item) => item.object_id === EVIDENCE_ID);
    expect(candidate).toMatchObject({
      object_id: EVIDENCE_ID,
      object_kind: "evidence_capsule",
      content_preview: recommendation
    });
    expect(findRecallQualifiedByIds).toHaveBeenCalledWith("workspace-1", [
      {
        object_id: EVIDENCE_ID,
        matched_projection: {
          projection_id: 1,
          projection_kind: "assistant_observation" as const
        }
      }
    ]);
    expect(result.diagnostics?.candidates.find((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )?.selector_observation?.evidence.source_role).toBe("assistant");
    expect(result.diagnostics?.candidates.find((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )?.answer_features?.answer_support_observations).toBeUndefined();
  });

  it("does not infer User authority or Assistant answer support from an owner-only v2 hit", async () => {
    const recommendation = "Choose the moss-green TrailShell pack.";
    const neutralOwnerExcerpt = "Signal turn-1 (potential_evidence_anchor)";
    const evidence = createEvidenceCapsule({
      gist: `Assistant: ${recommendation}`,
      excerpt: neutralOwnerExcerpt,
      source_hash: formatGardenSourceTurnFallbackV2SourceHash("d".repeat(64))
    });
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => []),
        findBoundEvidenceRefs: vi.fn(async () => []),
        findByIds: vi.fn(async () => [])
      },
      evidenceSearchPort: {
        ...keywordSearchMethods(vi.fn(async () => [{
          object_id: EVIDENCE_ID,
          normalized_rank: 0.95
        }])),
        findRecallQualifiedByIds: vi.fn(async () => [{
          capsule: evidence,
          verified_user_projection: false
        }])
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which backpack did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
    });

    const candidate = result.candidates.find((item) => item.object_id === EVIDENCE_ID);
    expect(candidate?.content_preview).toBe(neutralOwnerExcerpt);
    expect(candidate?.content_preview).not.toContain(recommendation);
    expect(result.diagnostics?.candidates.find((item) =>
      item.object_id === EVIDENCE_ID && item.object_kind === "evidence_capsule"
    )?.answer_features?.answer_support_observations).toBeUndefined();
  });

  it("prefers an equal-rank matched projection from a later query batch", async () => {
    const recommendation = "Choose the moss-green TrailShell pack.";
    const evidence = createEvidenceCapsule({
      excerpt: "Which backpack should I use?",
      source_hash: formatGardenSourceTurnFallbackV2SourceHash("e".repeat(64))
    });
    const qualified = {
      capsule: evidence,
      verified_user_projection: true,
      matched_projection: {
        projection_id: 1,
        projection_kind: "assistant_observation" as const,
        content: recommendation
      }
    };
    const findRecallQualifiedByIds = vi.fn(async (
      _workspaceId: string,
      _matches: readonly RecallEvidenceSearchMatch[]
    ) => [qualified]);
    const searchManyByKeywordField = vi.fn(async (
      _workspaceId: string,
      queries: readonly unknown[]
    ) => queries.map((_query, index) => keywordFieldResult([{
        object_id: EVIDENCE_ID,
        normalized_rank: 0.95,
        ...(index === 0 ? {} : {
          matched_projection: {
            projection_id: 1,
            projection_kind: "assistant_observation" as const
          }
        })
      }])));
    const scalarSearch = vi.fn(async () => []);
    const service = createEvidenceService({
      searchByKeyword: scalarSearch,
      searchByKeywordField: fieldSearchFromScalar(scalarSearch),
      searchManyByKeywordField,
      findRecallQualifiedByIds
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(
        'What did you say about the "moss-green TrailShell" backpack on 2026-07-25?'
      ),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
    });

    expect(searchManyByKeywordField.mock.calls[0]?.[1].length).toBeGreaterThan(1);
    expect(findRecallQualifiedByIds.mock.calls[0]?.[1]).toEqual([
      { object_id: EVIDENCE_ID },
      {
        object_id: EVIDENCE_ID,
        matched_projection: {
          projection_id: 1,
          projection_kind: "assistant_observation" as const
        }
      }
    ]);
    expect(result.candidates.find(
      (candidate) => candidate.object_id === EVIDENCE_ID
    )?.content_preview).toBe(recommendation);
  });

  it("keeps a slightly weaker matched projection reachable beside its owner", async () => {
    const recommendation = "Choose the moss-green TrailShell pack.";
    const evidence = createEvidenceCapsule({
      excerpt: "Which backpack should I use?",
      source_hash: formatGardenSourceTurnFallbackV2SourceHash("f".repeat(64))
    });
    const findRecallQualifiedByIds = vi.fn(async (
      _workspaceId: string,
      matches: readonly RecallEvidenceSearchMatch[]
    ) => matches.map((match) => match.matched_projection === undefined
      ? {
          capsule: evidence,
          verified_user_projection: true
        }
      : {
          capsule: evidence,
          verified_user_projection: true,
          matched_projection: {
            ...match.matched_projection,
            content: recommendation
          }
        }));
    const searchManyByKeywordField = vi.fn(async (
      _workspaceId: string,
      queries: readonly unknown[]
    ) => queries.map((_query, index) => keywordFieldResult([{
        object_id: EVIDENCE_ID,
        normalized_rank: index === 0 ? 0.96 : 0.95,
        ...(index === 0 ? {} : {
          matched_projection: {
            projection_id: 1,
            projection_kind: "assistant_observation" as const
          }
        })
      }])));
    const scalarSearch = vi.fn(async () => []);
    const service = createEvidenceService({
      searchByKeyword: scalarSearch,
      searchByKeywordField: fieldSearchFromScalar(scalarSearch),
      searchManyByKeywordField,
      findRecallQualifiedByIds
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Which TrailShell backpack did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
    });

    expect(findRecallQualifiedByIds.mock.calls[0]?.[1]).toEqual([
      { object_id: EVIDENCE_ID },
      {
        object_id: EVIDENCE_ID,
        matched_projection: {
          projection_id: 1,
          projection_kind: "assistant_observation" as const
        }
      }
    ]);
    expect(result.candidates.find(
      (candidate) => candidate.object_id === EVIDENCE_ID
    )?.content_preview).toBe(recommendation);
  });

  it("does not hide a qualified projection integrity failure as recall degradation", async () => {
    const integrityError = new Error("Evidence projection integrity failed");
    integrityError.name = "EvidenceProjectionIntegrityError";
    const fallback = vi.fn(async () => {
      throw new Error("fallback must not mask projection integrity");
    });
    const service = createEvidenceService({
      ...keywordSearchMethods(vi.fn(async () => [{
        object_id: EVIDENCE_ID,
        normalized_rank: 1,
        matched_projection: {
          projection_id: 1,
          projection_kind: "assistant_observation" as const
        }
      }])),
      findRecallQualifiedByIds: vi.fn(async () => {
        throw integrityError;
      })
    }, { findByEvidenceRefs: fallback });

    await expect(service.recall({
      taskSurface: createTaskSurface("Which TrailShell backpack did you recommend?"),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
})).rejects.toBe(integrityError);
    expect(fallback).not.toHaveBeenCalled();
  });
});

function createEvidenceService(
  evidenceSearchPort: Readonly<RecallServiceEvidenceSearchPort>,
  memoryRepoOverrides: Partial<RecallServiceMemoryRepoPort> = {}
): RecallService {
  const { dependencies } = createDependencies([]);
  return new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
    ...dependencies,
    memoryRepo: {
      ...dependencies.memoryRepo,
      searchByKeyword: vi.fn(async () => []),
      findByEvidenceRefs: vi.fn(async () => []),
      findBoundEvidenceRefs: vi.fn(async () => []),
      findByIds: vi.fn(async () => []),
      ...memoryRepoOverrides
    },
    evidenceSearchPort
  });
}

function createEvidenceCapsule(
  overrides: Partial<EvidenceCapsule>
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
      topic: "backpack recommendation",
      keywords: ["backpack", "TrailShell"],
      summary: "The Assistant recommended a TrailShell pack."
    },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: formatGardenSourceTurnFallbackArtifactRef("turn-1:assistant")
    },
    evidence_health_state: "verified",
    gist: "User: source question\nAssistant: source response",
    excerpt: "source question",
    source_hash: formatGardenSourceTurnFallbackV2SourceHash("a".repeat(64)),
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: "surface-1",
    ...overrides
  });
}
