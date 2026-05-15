import { describe, expect, it, vi } from "vitest";
import { PathRelationSchema } from "@do-soul/alaya-protocol";
import {
  PathRelationProposalService,
  PATH_RELATION_PROPOSE_THRESHOLD
} from "../path-relation-proposal-service.js";

describe("PathRelationProposalService", () => {
  it("does not propose before the threshold is reached", async () => {
    const repo = {
      create: vi.fn(async (relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const service = new PathRelationProposalService({ repo });

    for (let i = 1; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    expect(repo.create).not.toHaveBeenCalled();
  });

  it("proposes a PathRelation when the same pair co-occurs K times", async () => {
    const repo = {
      create: vi.fn(async (relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const service = new PathRelationProposalService({ repo });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    expect(repo.create).toHaveBeenCalledTimes(1);
    const written = repo.create.mock.calls[0][0];
    expect(written.workspace_id).toBe("workspace-1");
    const anchorIds = [
      written.anchors.source_anchor.object_id,
      written.anchors.target_anchor.object_id
    ].sort();
    expect(anchorIds).toEqual(["mem-A", "mem-B"]);
    // invariant: written object must round-trip through the strict schema.
    // The earlier version of this service mis-built fields (object_id /
    // object_kind / schema_version / lifecycle_state) that strict-mode
    // PathRelationSchema rejected, so the propose path silently warned.
    expect(() => PathRelationSchema.parse(written)).not.toThrow();
  });

  it("does not double-propose the same pair", async () => {
    const repo = {
      create: vi.fn(async (relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const service = new PathRelationProposalService({ repo });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD + 5; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("counts pairs symmetrically (mem-A,mem-B == mem-B,mem-A)", async () => {
    const repo = {
      create: vi.fn(async (relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const service = new PathRelationProposalService({ repo });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    await service.onCoUsage(["mem-B", "mem-A"], "workspace-1");
    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");

    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("ignores single-used pairs (no propose when len < 2)", async () => {
    const repo = {
      create: vi.fn(async (relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const service = new PathRelationProposalService({ repo });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A"], "workspace-1");
    }

    expect(repo.create).not.toHaveBeenCalled();
  });

  it("skips propose when a PathRelation already exists between the pair", async () => {
    const existing = {
      anchors: {
        source_anchor: { kind: "object" as const, object_id: "mem-A" },
        target_anchor: { kind: "object" as const, object_id: "mem-B" }
      }
    };
    const repo = {
      create: vi.fn(async (relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [existing])
    };
    const service = new PathRelationProposalService({ repo, threshold: 1 });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");

    expect(repo.create).not.toHaveBeenCalled();
  });
});
