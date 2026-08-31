import { describe, expect, it, vi } from "vitest";
import { collectRecallEvidenceContexts } from
  "../../../../recall/supplements/evidence/evidence-contexts.js";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";
import {
  BOOKSHELF_ASSERTION,
  createVerifiedAssertionEvidence,
  materializeBookshelfFactFrame
} from "../../evidence-contexts-assertion-fixture.js";

describe("recall evidence contexts for typed fact-frame formations", () => {
  it("does not index fact-frame formations when answer-feature capture is off", async () => {
    const entry = createMemoryEntry({
      content: BOOKSHELF_ASSERTION,
      evidence_refs: ["evidence-1"]
    });
    const evidence = createVerifiedAssertionEvidence();
    const formed = materializeBookshelfFactFrame(evidence.source_hash);
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [evidence]),
          findRecallQualifiedByIds: vi.fn(async () => [{
            capsule: evidence,
            verified_user_projection: false,
            fact_frame_formation: formed
          }])
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [entry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {}
    });
    expect(contexts).not.toHaveProperty("factFrameFormationsByEvidenceId");
  });

  it("loads a direct evidence-capsule candidate that no memory references", async () => {
    const evidence = createVerifiedAssertionEvidence({ objectId: "evidence-capsule-only" });
    const formed = materializeBookshelfFactFrame(evidence.source_hash);
    const findByIds = vi.fn(async () => [evidence]);
    const findFactKeys = vi.fn(async () => []);
    const findQualified = vi.fn(async () => [{
      capsule: evidence,
      verified_user_projection: false,
      fact_frame_formation: formed
    }]);
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds,
          findRecallQualifiedByIds: findQualified,
          findRecallQualifiedFactKeysByIds: findFactKeys
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {},
      captureFactFrameObjectIds: [evidence.object_id],
      captureAnswerFeatures: true
    });
    expect(findByIds).not.toHaveBeenCalled();
    expect(findFactKeys).not.toHaveBeenCalled();
    expect(findQualified).toHaveBeenCalledTimes(1);
    expect(findQualified).toHaveBeenCalledWith("workspace-1", [
      { object_id: evidence.object_id }
    ]);
    expect(contexts.semanticFactorFormationsByEvidenceId).toEqual({});
    expect(contexts.factFrameFormationsByEvidenceId?.[evidence.object_id]).toEqual(formed);
  });

  it("does not attach a sibling capsule formation onto a memory's fact-key documents", async () => {
    const entry = createMemoryEntry({
      content: BOOKSHELF_ASSERTION,
      evidence_refs: ["evidence-alice"]
    });
    const alice = createVerifiedAssertionEvidence({ objectId: "evidence-alice" });
    const bob = createVerifiedAssertionEvidence({ objectId: "evidence-bob" });
    const aliceFormed = materializeBookshelfFactFrame(alice.source_hash);
    const bobFormed = materializeBookshelfFactFrame(bob.source_hash);
    const findByIds = vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
      [alice, bob].filter((item) => ids.includes(item.object_id))
    );
    const findFactKeys = vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
      [
        {
          capsule: alice,
          verified_user_projection: false,
          matched_projection: {
            projection_id: 5,
            projection_kind: "fact_key" as const,
            content: "Alice lives Paris"
          }
        },
        {
          capsule: bob,
          verified_user_projection: false,
          matched_projection: {
            projection_id: 6,
            projection_kind: "fact_key" as const,
            content: "Bob lives Berlin"
          }
        }
      ].filter((item) => ids.includes(item.capsule.object_id))
    );
    const findQualified = vi.fn(async (
      _workspaceId: string,
      refs: readonly Readonly<{ readonly object_id: string }>[]
    ) => {
      const ids = new Set(refs.map((ref) => ref.object_id));
      return [
        { capsule: alice, verified_user_projection: false, fact_frame_formation: aliceFormed },
        { capsule: bob, verified_user_projection: false, fact_frame_formation: bobFormed }
      ].filter((item) => ids.has(item.capsule.object_id));
    });
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds,
          findRecallQualifiedByIds: findQualified,
          findRecallQualifiedFactKeysByIds: findFactKeys
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [entry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {},
      captureFactFrameObjectIds: [alice.object_id, bob.object_id],
      captureAnswerFeatures: true
    });
    expect(findByIds).toHaveBeenCalledWith("workspace-1", [alice.object_id]);
    expect(findFactKeys).toHaveBeenCalledWith("workspace-1", [alice.object_id]);
    expect(findQualified.mock.calls.map((call) => call[1])).toEqual([
      [{ object_id: alice.object_id }],
      [{ object_id: bob.object_id }]
    ]);
    expect(contexts.factFrameFormationsByEvidenceId).toEqual({
      [alice.object_id]: aliceFormed,
      [bob.object_id]: bobFormed
    });
    expect(contexts.evidenceSemanticDocumentsByMemoryId[entry.object_id])
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          evidenceRef: alice.object_id,
          documentIdentity: "fact_key:5"
        })
      ]));
    expect(JSON.stringify(contexts.evidenceSemanticDocumentsByMemoryId))
      .not.toContain("Berlin");
  });
});
