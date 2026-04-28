import { describe, expect, it, vi } from "vitest";
import {
  GLOBAL_MEMORY_ENTRY_OBJECT_KIND,
  MemoryDimension,
  ObjectLifecycleState,
  ProjectMappingState,
  ScopeClass,
  type ProjectMappingAnchor
} from "@do-what/protocol";
import type { GlobalMemoryRecallEntry } from "../global-memory-recall-port.js";
import {
  createGlobalMemoryRecallPort,
  loadGlobalRecallCandidates
} from "../global-memory-recall-service.js";
import { classifyGlobalCandidate } from "../recall-service.js";

function createGlobalEntry(overrides: Partial<GlobalMemoryRecallEntry> = {}): GlobalMemoryRecallEntry {
  return {
    global_object_id: "global-1",
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: "Global recall content",
    domain_tags: ["repo"],
    evidence_refs: ["evidence-1"],
    activation_score: 0.8,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}

function createAnchor(overrides: Partial<ProjectMappingAnchor> = {}): ProjectMappingAnchor {
  return {
    object_id: "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    created_by: "system",
    global_object_id: "global-1",
    project_id: "workspace-1",
    workspace_id: "workspace-1",
    mapping_state: ProjectMappingState.SUGGESTED,
    accepted_by: null,
    last_transition_at: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}

describe("loadGlobalRecallCandidates", () => {
  it("ensures surfaced anchors, excludes non-adopted globals, and returns per-entry candidate outcomes", async () => {
    const recall = vi.fn(async () => [
      createGlobalEntry({ global_object_id: "global-accepted" }),
      createGlobalEntry({ global_object_id: "global-suggested" }),
      createGlobalEntry({ global_object_id: "global-missing" })
    ]);
    const ensureSuggestedAnchors = vi.fn(async () => [
      createAnchor({
        object_id: "mapping-accepted",
        global_object_id: "global-accepted",
        mapping_state: ProjectMappingState.ACCEPTED
      }),
      createAnchor({
        object_id: "mapping-suggested",
        global_object_id: "global-suggested",
        mapping_state: ProjectMappingState.SUGGESTED
      }),
      createAnchor({
        object_id: "mapping-created",
        global_object_id: "global-missing",
        mapping_state: ProjectMappingState.SUGGESTED
      })
    ]);
    const result = await loadGlobalRecallCandidates({
      workspaceId: "workspace-1",
      queryText: "Implement recall",
      limit: 5,
      createdBy: "system",
      globalRecallPort: { recall },
      projectMappingPort: {
        findByWorkspace: vi.fn(async () => {
          throw new Error("ensureSuggestedAnchors should be preferred when available");
        }),
        ensureSuggestedAnchors
      },
      classifyGlobalCandidate
    });

    expect(recall).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      queryText: "Implement recall",
      limit: 5
    });
    expect(ensureSuggestedAnchors).toHaveBeenCalledWith(
      ["global-accepted", "global-suggested", "global-missing"],
      "workspace-1",
      "system"
    );
    expect(result.total_scanned).toBe(3);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      originPlane: "global",
      isAdvisory: false,
      entry: {
        object_id: "global-accepted",
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Global recall content"
      }
    });
    expect(result.records).toEqual([
      {
        globalObjectId: "global-accepted",
        candidate: expect.objectContaining({
          originPlane: "global",
          entry: expect.objectContaining({
            object_id: "global-accepted"
          })
        })
      },
      {
        globalObjectId: "global-suggested",
        candidate: null
      },
      {
        globalObjectId: "global-missing",
        candidate: null
      }
    ]);
  });
});

describe("createGlobalMemoryRecallPort", () => {
  it("owns global recall query matching and ranking outside daemon bootstrap", async () => {
    const list = vi.fn(async () => [
      createSourceEntry({
        global_object_id: "global-low",
        canonical_identity: "Alpha policy",
        content: "Global alpha recall",
        provenance: "repo docs",
        domain_tags: ["alpha"],
        activation_score: 0.3,
        updated_at: "2026-04-23T00:00:00.000Z",
        created_at: "2026-04-22T00:00:00.000Z"
      }),
      createSourceEntry({
        global_object_id: "global-high",
        canonical_identity: "Alpha policy",
        content: "Global alpha recall",
        provenance: "repo docs",
        domain_tags: ["alpha"],
        activation_score: 0.9,
        updated_at: "2026-04-22T00:00:00.000Z",
        created_at: "2026-04-21T00:00:00.000Z"
      }),
      createSourceEntry({
        global_object_id: "global-same-score-newer",
        canonical_identity: "Alpha policy",
        content: "Global alpha recall",
        provenance: "repo docs",
        domain_tags: ["alpha"],
        activation_score: 0.9,
        updated_at: "2026-04-23T12:00:00.000Z",
        created_at: "2026-04-20T00:00:00.000Z"
      }),
      createSourceEntry({
        global_object_id: "global-miss",
        canonical_identity: "Beta policy",
        content: "Unrelated memory",
        provenance: "other source",
        domain_tags: ["beta"],
        activation_score: 1
      })
    ]);
    const port = createGlobalMemoryRecallPort({
      globalMemorySource: { list }
    });

    const result = await port.recall({
      workspaceId: "workspace-1",
      queryText: "alpha repo",
      limit: 2
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      expect.objectContaining({
        global_object_id: "global-same-score-newer",
        content: "Global alpha recall"
      }),
      expect.objectContaining({
        global_object_id: "global-high",
        content: "Global alpha recall"
      })
    ]);
  });
});

function createSourceEntry(
  overrides: Partial<{
    readonly global_object_id: string;
    readonly canonical_identity: string;
    readonly dimension: MemoryDimension;
    readonly scope_class: ScopeClass;
    readonly content: string;
    readonly domain_tags: readonly string[];
    readonly provenance: string;
    readonly activation_score: number | null;
    readonly created_at: string;
    readonly updated_at: string;
  }> = {}
) {
  return {
    global_object_id: "global-source-1",
    object_kind: GLOBAL_MEMORY_ENTRY_OBJECT_KIND,
    canonical_identity: "Global identity",
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: "Global recall content",
    domain_tags: ["repo"],
    provenance: "docs",
    activation_score: 0.5,
    version: 1,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}
