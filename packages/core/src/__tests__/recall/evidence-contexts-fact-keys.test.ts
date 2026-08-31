import { formatVerifiedUserAssertionSourceHash } from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { collectRecallEvidenceContexts } from
  "../../recall/supplements/evidence/evidence-contexts.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";
import {
  BOOKSHELF_ASSERTION as ASSERTION,
  createVerifiedAssertionEvidence,
  materializeBookshelfFactFrame
} from "./evidence-contexts-assertion-fixture.js";

describe("recall evidence contexts for associative fact keys", () => {
  it("feeds one source-qualified fact-key field to semantic scoring", async () => {
    const entry = createMemoryEntry({
      content: ASSERTION,
      evidence_refs: ["evidence-1"]
    });
    const evidence = createVerifiedAssertionEvidence();
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [evidence]),
          findRecallQualifiedFactKeysByIds: vi.fn(async () => [{
            capsule: evidence,
            verified_user_projection: false,
            matched_fact_key_forms: [{
              kind: "leave_one_slot_out" as const,
              omitted_slot: { slot_index: 2, role: "value" as const }
            }],
            matched_projection: {
              projection_id: 5,
              projection_kind: "fact_key" as const,
              content: "I bought my bookshelf"
            }
          }])
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [entry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {}
    });

    expect(contexts.evidenceSemanticDocumentsByMemoryId[entry.object_id]).toEqual([
      {
        evidenceRef: "evidence-1",
        documentIdentity: "fact_key:5",
        content: "I bought my bookshelf",
        projection: {
          projection_id: 5,
          projection_kind: "fact_key",
          matched_fact_key_forms: [{
            kind: "leave_one_slot_out",
            omitted_slot: { slot_index: 2, role: "value" }
          }]
        }
      }
    ]);
    expect(contexts.semanticFactorFormationUnavailableEvidenceIds)
      .toEqual(["evidence-1"]);
  });

  it("names a qualified evidence capsule whose semantic formation is absent", async () => {
    const entry = createMemoryEntry({
      content: ASSERTION,
      evidence_refs: ["evidence-without-formation"]
    });
    const evidence = createVerifiedAssertionEvidence({
      objectId: "evidence-without-formation"
    });
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [evidence]),
          findRecallQualifiedByIds: vi.fn(async () => [{
            capsule: evidence,
            verified_user_projection: false
          }])
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [entry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {}
    });

    expect(contexts.semanticFactorFormationUnavailableEvidenceIds)
      .toEqual(["evidence-without-formation"]);
  });

  it("copies owner fact-frame formations by evidence id without joining fact-key rows", async () => {
    const entry = createMemoryEntry({
      content: ASSERTION,
      evidence_refs: ["evidence-1"]
    });
    const evidence = createVerifiedAssertionEvidence();
    const sourceHash = evidence.source_hash;
    if (sourceHash === null) throw new Error("expected source_hash");
    const formed = materializeBookshelfFactFrame(sourceHash);
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [evidence]),
          findRecallQualifiedByIds: vi.fn(async () => [{
            capsule: evidence,
            verified_user_projection: false,
            fact_frame_formation: formed
          }]),
          findRecallQualifiedFactKeysByIds: vi.fn(async () => [{
            capsule: evidence,
            verified_user_projection: false,
            matched_projection: {
              projection_id: 5,
              projection_kind: "fact_key" as const,
              content: "I bought my bookshelf"
            },
            matched_fact_frame: formed.fact_frame ?? undefined
          }])
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [entry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {},
      captureAnswerFeatures: true
    });

    expect(contexts.factFrameFormationsByEvidenceId?.[evidence.object_id]).toEqual(formed);
    expect(contexts.factFrameFormationsByEvidenceId?.[evidence.object_id]
      ?.producer_operator_id).toBe("test_grounded_fact_frame_v1");
  });

  it("isolates an invalid receipt owner without clearing valid sibling fact keys", async () => {
    const validEntry = createMemoryEntry({
      object_id: "memory-valid",
      content: ASSERTION,
      evidence_refs: ["evidence-valid"]
    });
    const invalidEntry = createMemoryEntry({
      object_id: "memory-invalid",
      content: "I bought my desk from IKEA.",
      evidence_refs: ["evidence-invalid"]
    });
    const validEvidence = createVerifiedAssertionEvidence({
      objectId: "evidence-valid"
    });
    const invalidEvidence = {
      ...createVerifiedAssertionEvidence({
        objectId: "evidence-invalid",
        assertion: invalidEntry.content
      }),
      source_hash: formatVerifiedUserAssertionSourceHash("0".repeat(64))
    };
    const invalidOwnerError = new Error(
      "evidence-invalid does not match its verified receipt"
    );
    invalidOwnerError.name = "EvidenceProjectionIntegrityError";
    const warn = vi.fn();
    const findFactKeys = vi.fn(async (
      _workspaceId: string,
      evidenceIds: readonly string[]
    ) => {
      if (evidenceIds.includes(invalidEvidence.object_id)) {
        throw invalidOwnerError;
      }
      return [{
        capsule: validEvidence,
        verified_user_projection: false,
        matched_fact_key_forms: [{
          kind: "leave_one_slot_out" as const,
          omitted_slot: { slot_index: 2, role: "value" as const }
        }],
        matched_projection: {
          projection_id: 5,
          projection_kind: "fact_key" as const,
          content: "I bought my bookshelf"
        }
      }];
    });

    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [validEvidence, invalidEvidence]),
          findRecallQualifiedFactKeysByIds: findFactKeys
        }
      },
      warn,
      workspaceId: "workspace-1",
      candidates: [validEntry, invalidEntry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {}
    });

    expect.soft(contexts.evidenceSemanticDocumentsByMemoryId[validEntry.object_id])
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ documentIdentity: "fact_key:5" })
      ]));
    expect.soft(contexts.verifiedUserAssertionContextsByMemoryId[invalidEntry.object_id])
      .toBeUndefined();
    expect.soft(contexts.evidenceSemanticDocumentsByMemoryId[invalidEntry.object_id] ?? [])
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ documentIdentity: "fact_key:5" })
      ]));
    expect.soft(warn).toHaveBeenCalledWith(
      "fact-key evidence context lookup failed",
      expect.objectContaining({ error: invalidOwnerError.message })
    );
  });

  it("names semantic formation ids isolated after a qualified lookup integrity failure", async () => {
    const left = createMemoryEntry({
      object_id: "memory-left-semantic",
      evidence_refs: ["evidence-left-semantic"]
    });
    const right = createMemoryEntry({
      object_id: "memory-right-semantic",
      evidence_refs: ["evidence-right-semantic"]
    });
    const leftEvidence = createVerifiedAssertionEvidence({
      objectId: "evidence-left-semantic"
    });
    const rightEvidence = createVerifiedAssertionEvidence({
      objectId: "evidence-right-semantic"
    });
    const integrityError = new Error("semantic formation receipt mismatch");
    integrityError.name = "EvidenceProjectionIntegrityError";

    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [leftEvidence, rightEvidence]),
          findRecallQualifiedByIds: vi.fn(async () => {
            throw integrityError;
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [left, right],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {}
    });

    expect(contexts.semanticFactorFormationUnavailableEvidenceIds).toEqual([
      "evidence-left-semantic",
      "evidence-right-semantic"
    ]);
  });

  it("names all semantic formation ids when evidence context loading fails upstream", async () => {
    const entry = createMemoryEntry({
      evidence_refs: ["evidence-upstream-failure"]
    });
    const evidence = createVerifiedAssertionEvidence({
      objectId: "evidence-upstream-failure"
    });
    const warn = vi.fn();

    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => {
            throw new Error("evidence store unavailable");
          }),
          findRecallQualifiedByIds: vi.fn(async () => [{
            capsule: evidence,
            verified_user_projection: false
          }])
        }
      },
      warn,
      workspaceId: "workspace-1",
      candidates: [entry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {}
    });

    expect(contexts.semanticFactorFormationUnavailableEvidenceIds)
      .toEqual(["evidence-upstream-failure"]);
    expect(warn).toHaveBeenCalledWith(
      "evidence context lookup for coverage and answer authority failed",
      expect.objectContaining({ error: "evidence store unavailable" })
    );
  });

  it("stops recursive isolation when a child lookup throws a non-integrity error", async () => {
    const leftEntry = createMemoryEntry({
      object_id: "memory-left",
      content: ASSERTION,
      evidence_refs: ["evidence-left"]
    });
    const rightEntry = createMemoryEntry({
      object_id: "memory-right",
      content: "I bought my desk from IKEA.",
      evidence_refs: ["evidence-right"]
    });
    const leftEvidence = createVerifiedAssertionEvidence({
      objectId: "evidence-left"
    });
    const rightEvidence = createVerifiedAssertionEvidence({
      objectId: "evidence-right",
      assertion: rightEntry.content
    });
    const rootIntegrityError = new Error("mixed receipt integrity failure");
    rootIntegrityError.name = "EvidenceProjectionIntegrityError";
    const childLookupError = new Error("fact-key storage unavailable");
    const findFactKeys = vi.fn(async (
      _workspaceId: string,
      evidenceIds: readonly string[]
    ) => {
      if (evidenceIds.length > 1) throw rootIntegrityError;
      if (evidenceIds[0] === leftEvidence.object_id) throw childLookupError;
      return [{
        capsule: rightEvidence,
        verified_user_projection: false,
        matched_fact_key_forms: [],
        matched_projection: {
          projection_id: 6,
          projection_kind: "fact_key" as const,
          content: "I bought my desk"
        }
      }];
    });
    const warn = vi.fn();

    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [leftEvidence, rightEvidence]),
          findRecallQualifiedFactKeysByIds: findFactKeys
        }
      },
      warn,
      workspaceId: "workspace-1",
      candidates: [leftEntry, rightEntry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {}
    });

    expect(contexts).toEqual({
      evidenceGistsByMemoryId: {},
      evidenceSemanticDocumentsByMemoryId: {},
      verifiedUserAssertionContextsByMemoryId: {},
      semanticFactorFormationsByEvidenceId: {},
      semanticFactorFormationUnavailableEvidenceIds: [
        "evidence-left",
        "evidence-right"
      ]
    });
    expect(findFactKeys.mock.calls.map((call) => call[1])).toEqual([
      ["evidence-left", "evidence-right"],
      ["evidence-left"]
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "evidence context lookup for coverage and answer authority failed",
      expect.objectContaining({
        errorName: "Error",
        error: childLookupError.message
      })
    );
  });
});
