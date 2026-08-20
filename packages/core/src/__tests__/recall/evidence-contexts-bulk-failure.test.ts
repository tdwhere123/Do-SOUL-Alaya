import { describe, expect, it, vi } from "vitest";
import { collectRecallEvidenceContexts } from
  "../../recall/supplements/evidence/evidence-contexts.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("collectRecallEvidenceContexts bulk failure", () => {
  it("records evidence_context_bulk_failed instead of a silent empty context", async () => {
    const emptyHits = new Set<"evidence_context_bulk_failed">();
    const empty = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [])
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [createMemoryEntry({
        object_id: "memory-1",
        evidence_refs: ["evidence-1"]
      })],
      coarseEvidenceFtsRanks: { "memory-1": 1 },
      coarseEvidenceFtsRanksPerRef: { "evidence-1": 1 },
      degradationReasons: emptyHits
    });

    const degradationReasons = new Set<"evidence_context_bulk_failed">();
    const warn = vi.fn();
    const failed = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => {
            throw new Error("bulk evidence read failed");
          })
        }
      },
      warn,
      workspaceId: "workspace-1",
      candidates: [createMemoryEntry({
        object_id: "memory-1",
        evidence_refs: ["evidence-1"]
      })],
      coarseEvidenceFtsRanks: { "memory-1": 1 },
      coarseEvidenceFtsRanksPerRef: { "evidence-1": 1 },
      degradationReasons
    });

    expect(empty.evidenceGistsByMemoryId).toEqual({});
    expect(failed.evidenceGistsByMemoryId).toEqual({});
    expect(emptyHits.size).toBe(0);
    expect(degradationReasons).toEqual(new Set(["evidence_context_bulk_failed"]));
    expect(warn).toHaveBeenCalledWith(
      "evidence context lookup for coverage and answer authority failed",
      expect.objectContaining({
        operation: "evidence_gist_lookup_for_coverage",
        error: "bulk evidence read failed"
      })
    );
  });
});
