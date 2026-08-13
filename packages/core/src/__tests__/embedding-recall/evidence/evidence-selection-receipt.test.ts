import { describe, expect, it, vi } from "vitest";
import { EmbeddingRecallService } from
  "../../../embedding-recall/embedding-recall-service.js";
import type { EvidenceCandidateScoringSelectionReceipt } from
  "../../../embedding-recall/types.js";
import { createProvider } from "../embedding-recall-test-helpers.js";

describe("evidence scoring selection receipt", () => {
  it("reuses identical content vectors while retaining distinct identities", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0]))
    );
    const result = await createService(embedTexts).scoreEvidenceCandidates(request([{
      candidateKey: "memory:1", evidenceObjectId: "evidence-1",
      documentIdentity: "owner_gist_600", content: "shared evidence"
    }, {
      candidateKey: "memory:1", evidenceObjectId: "evidence-1",
      documentIdentity: "owner", content: "shared evidence"
    }]));

    expect(embedTexts.mock.calls.map(([texts]) => texts)).toEqual([
      ["query"], ["shared evidence"]
    ]);
    expect(result.activationsByCandidateKey.get("memory:1")?.observations)
      .toHaveLength(2);
  });

  it("marks candidates outside a receipt prefix as bounded observations", async () => {
    const inputCandidateKeys = Array.from({ length: 17 }, (_, index) =>
      `workspace_local:memory_entry:memory-${index + 1}`
    );
    const key = inputCandidateKeys[16]!;
    const result = await createService(vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0]))
    )).scoreEvidenceCandidates(request([{
      candidateKey: key, evidenceObjectId: "evidence-1",
      documentIdentity: "owner", content: "bounded evidence"
    }], selectionReceipt(inputCandidateKeys)));

    expect(result.activationsByCandidateKey.get(key)?.observation_completeness)
      .toBe("bounded_candidate_prefix");
  });
});

function createService(embedTexts: ReturnType<typeof vi.fn>): EmbeddingRecallService {
  return new EmbeddingRecallService({
    embeddingRepo: { listByObjectIds: vi.fn(async () => []) },
    provider: createProvider({ embedTexts }),
    eventLogRepo: { append: vi.fn(), queryByEntity: vi.fn(async () => []) }
  });
}

function request(
  candidates: import("../../../embedding-recall/types.js").EvidenceEmbeddingCandidate[],
  selectionReceipt?: EvidenceCandidateScoringSelectionReceipt
) {
  return { workspaceId: "workspace-1", runId: null, queryText: "query",
    preparedQuery: null, candidates, selectionReceipt };
}

function selectionReceipt(
  inputCandidateKeys: readonly string[]
): EvidenceCandidateScoringSelectionReceipt {
  return { schema_version: 1, operator_id: "ordered_candidate_prefix_v1",
    input_candidate_keys: inputCandidateKeys, owner_gist_enabled: true,
    owner_gist_candidate_keys: inputCandidateKeys.slice(0, 16),
    full_evidence_candidate_keys: inputCandidateKeys, owner_gist_limit: 16,
    full_evidence_limit: 32, input_memory_count: 17,
    owner_gist_selected_count: 16, full_evidence_selected_count: 17,
    owner_gist_excluded_count: 1, full_evidence_excluded_count: 0 };
}
