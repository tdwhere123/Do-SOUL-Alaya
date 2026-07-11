import { describe, expect, it, vi } from "vitest";
import type { PathRelation } from "@do-soul/alaya-protocol";
import {
  PathRelationProposalService,
  type SubmitCandidateInput
} from "../../path-graph/edge-proposals/path-relation-proposal-service.js";
import {
  createCounterStore,
  createEventPublisher
} from "./path-relation-proposal-service.test-support.js";

function candidate(overrides: Partial<SubmitCandidateInput>): SubmitCandidateInput {
  return {
    workspaceId: "workspace-1",
    sourceAnchor: { kind: "object", object_id: "mem-A" },
    targetAnchor: { kind: "object", object_id: "mem-B" },
    relationKind: "supports",
    initialStrength: 0.5,
    governanceClass: "attention_only",
    evidenceBasis: ["identity-test"],
    recallBiasSign: 1,
    ...overrides
  };
}

function serviceWithExisting(existing: PathRelation) {
  const repo = {
    create: vi.fn((relation: PathRelation) => relation),
    findByAnchorMemoryId: vi.fn(async () => [existing])
  };
  const { publisher } = createEventPublisher();
  return {
    repo,
    service: new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    })
  };
}

describe("PathRelationProposalService typed anchor identity", () => {
  it("materializes a distinct facet on the same backing object", async () => {
    const existing = {
      anchors: {
        source_anchor: {
          kind: "object_facet",
          object_id: "mem-A",
          facet_key: "status"
        },
        target_anchor: {
          kind: "time_concern",
          source_object_id: "mem-B",
          window_digest: "next_week"
        }
      },
      constitution: { relation_kind: "supports" },
      effect_vector: { recall_bias: 0.5 }
    } as PathRelation;
    const { repo, service } = serviceWithExisting(existing);

    const result = await service.submitCandidate(candidate({
      sourceAnchor: {
        kind: "object_facet",
        object_id: "mem-A",
        facet_key: "priority"
      },
      targetAnchor: {
        kind: "time_concern",
        source_object_id: "mem-B",
        window_digest: "next_week"
      }
    }));

    expect(result).toBe("applied");
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("materializes a distinct time window on the same backing object", async () => {
    const existing = {
      anchors: {
        source_anchor: {
          kind: "object_facet",
          object_id: "mem-A",
          facet_key: "status"
        },
        target_anchor: {
          kind: "time_concern",
          source_object_id: "mem-B",
          window_digest: "next_week"
        }
      },
      constitution: { relation_kind: "supports" },
      effect_vector: { recall_bias: 0.5 }
    } as PathRelation;
    const { repo, service } = serviceWithExisting(existing);

    const result = await service.submitCandidate(candidate({
      sourceAnchor: existing.anchors.source_anchor,
      targetAnchor: {
        kind: "time_concern",
        source_object_id: "mem-B",
        window_digest: "next_month"
      }
    }));

    expect(result).toBe("applied");
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("deduplicates an unordered relation when exact full anchors are reversed", async () => {
    const existing = {
      anchors: {
        source_anchor: {
          kind: "object_facet",
          object_id: "mem-A",
          facet_key: "status"
        },
        target_anchor: {
          kind: "time_concern",
          source_object_id: "mem-B",
          window_digest: "next_week"
        }
      },
      constitution: { relation_kind: "coheres_with" },
      effect_vector: { recall_bias: 0.5 }
    } as PathRelation;
    const { repo, service } = serviceWithExisting(existing);

    const result = await service.submitCandidate(candidate({
      sourceAnchor: existing.anchors.target_anchor,
      targetAnchor: existing.anchors.source_anchor,
      relationKind: "coheres_with"
    }));

    expect(result).toBe("already_present");
    expect(repo.create).not.toHaveBeenCalled();
  });
});
