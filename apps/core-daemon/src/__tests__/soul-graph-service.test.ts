import { describe, expect, it } from "vitest";
import { createSoulGraphService } from "../daemon-runtime-support.js";
import type {
  SqliteMemoryEntryRepo,
  SqliteMemoryGraphEdgeRepo
} from "@do-soul/alaya-storage";

describe("createSoulGraphService", () => {
  it("projects shared domain tags as read-only scope nodes and belongs_to edges", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({ object_id: "memory-a", domain_tags: ["tooling", "workflow"] }),
          createMemory({ object_id: "memory-b", domain_tags: ["tooling"] })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: {
        findByWorkspace: async () => []
      } as unknown as SqliteMemoryGraphEdgeRepo
    });

    const graph = await service.buildSoulGraph({
      workspaceId: "default",
      depth: 2,
      limit: 10
    });

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "memory-a", kind: "memory" }),
        expect.objectContaining({ id: "memory-b", kind: "memory" }),
        expect.objectContaining({
          id: "scope:domain_tag:tooling",
          kind: "scope",
          label: "#tooling"
        })
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "domain_tag:memory-a:tooling",
          kind: "belongs_to",
          source_id: "memory-a",
          target_id: "scope:domain_tag:tooling"
        }),
        expect.objectContaining({
          id: "domain_tag:memory-b:tooling",
          kind: "belongs_to",
          source_id: "memory-b",
          target_id: "scope:domain_tag:tooling"
        })
      ])
    );
    expect(graph.edge_total).toBe(3);
  });
});

function createMemory(overrides: {
  readonly object_id: string;
  readonly domain_tags: readonly string[];
}) {
  return {
    object_id: overrides.object_id,
    content: `${overrides.object_id} content`,
    workspace_id: "default",
    created_at: "2026-05-05T00:00:00.000Z",
    domain_tags: overrides.domain_tags
  };
}
