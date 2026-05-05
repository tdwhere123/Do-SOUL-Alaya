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
          createMemory({
            object_id: "memory-a",
            content: "First line summary\n\nSecond paragraph with more details about tooling.",
            domain_tags: ["tooling", "workflow"]
          }),
          createMemory({
            object_id: "memory-b",
            content: "memory-b content",
            domain_tags: ["tooling"]
          })
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
        expect.objectContaining({
          id: "memory-a",
          kind: "memory",
          label: "First line summary",
          scope_id: "project",
          origin_plane: "project"
        }),
        expect.objectContaining({
          id: "memory-b",
          kind: "memory",
          label: "memory-b content"
        }),
        expect.objectContaining({
          id: "scope:domain_tag:tooling",
          kind: "scope",
          label: "#tooling",
          scope_id: "domain_tag:tooling"
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

  it("makes memory node labels and summaries non-redundant", async () => {
    const longContent = "Headline of the memory\n" + "x".repeat(400);
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({
            object_id: "long-memory",
            content: longContent,
            domain_tags: []
          }),
          createMemory({
            object_id: "short-memory",
            content: "tiny",
            domain_tags: []
          })
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

    const longNode = graph.nodes.find((n) => n.id === "long-memory");
    expect(longNode).toBeDefined();
    expect(longNode?.label).toBe("Headline of the memory");
    expect(longNode?.summary).toBeDefined();
    expect(longNode?.summary).not.toBe(longNode?.label);
    expect(longNode?.summary?.length).toBeLessThanOrEqual(280);
    expect(longNode?.summary?.endsWith("…")).toBe(true);

    // Short content where label already covers everything: no redundant summary.
    const shortNode = graph.nodes.find((n) => n.id === "short-memory");
    expect(shortNode?.label).toBe("tiny");
    expect(shortNode?.summary).toBeUndefined();
  });

  it("derives origin_plane from scope_class for global memories", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({
            object_id: "global-memory",
            content: "Global core knowledge",
            domain_tags: [],
            scope_class: "global_core"
          })
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

    expect(graph.nodes[0]).toMatchObject({
      id: "global-memory",
      origin_plane: "global",
      scope_id: "global_core"
    });
  });

  it("describes domain tag scope nodes with member sample summary", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({
            object_id: "m1",
            content: "Rust tooling notes",
            domain_tags: ["tooling"]
          }),
          createMemory({
            object_id: "m2",
            content: "Vitest workflow",
            domain_tags: ["tooling"]
          })
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

    const tagNode = graph.nodes.find((n) => n.id === "scope:domain_tag:tooling");
    expect(tagNode?.summary).toBe("2 memories · Rust tooling notes · Vitest workflow");
  });
});

function createMemory(overrides: {
  readonly object_id: string;
  readonly content?: string;
  readonly domain_tags: readonly string[];
  readonly scope_class?: "project" | "global_domain" | "global_core";
}) {
  return {
    object_id: overrides.object_id,
    content: overrides.content ?? `${overrides.object_id} content`,
    workspace_id: "default",
    created_at: "2026-05-05T00:00:00.000Z",
    domain_tags: overrides.domain_tags,
    scope_class: overrides.scope_class ?? "project"
  };
}
