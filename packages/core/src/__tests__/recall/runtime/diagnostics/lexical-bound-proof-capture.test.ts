import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../../recall/recall-service.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import { verifyLexicalBoundProof } from
  "../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import { capturesRecallAnswerFeatures } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import { unavailableProducerDigest } from
  "../../../../recall/runtime/snapshot-coherence/index.js";
import {
  completeReceipt,
  fieldResult,
  stubMemoryRepo,
  truncatedReceipt
} from "./lexical-bound-proof-fixture.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../../recall-service-test-fixtures.js";

describe("lexical bound proof capture path", () => {
  it("seals only a supplied prepared base-store snapshot on the live recall path", async () => {
    const snapshotDigest = `sha256:${"b".repeat(64)}` as const;
    const supplied = await recallWithLexicalDiagnostic(snapshotDigest, true);
    const unavailable = await recallWithLexicalDiagnostic(undefined, true);
    const captureOff = await recallWithLexicalDiagnostic(snapshotDigest, false);

    expect(supplied.result.diagnostics?.lexical_bound_proofs).not.toHaveLength(0);
    expect(supplied.result.diagnostics?.lexical_bound_proofs?.every((proof) =>
      proof.status === "captured" && proof.identity.snapshot_digest === snapshotDigest
    )).toBe(true);
    expect(unavailable.result.diagnostics?.lexical_bound_proofs?.every((proof) =>
      proof.status === "captured" &&
      typeof proof.identity.snapshot_digest !== "string" &&
      proof.identity.snapshot_digest.reason === "snapshot_not_sealed"
    )).toBe(true);
    expect(captureOff.result.diagnostics).not.toHaveProperty("lexical_bound_proofs");

    const { diagnostics: _suppliedDiagnostics, ...suppliedPublic } = supplied.result;
    const { diagnostics: _captureOffDiagnostics, ...captureOffPublic } = captureOff.result;
    expect(suppliedPublic).toEqual(captureOffPublic);
    expect(JSON.stringify(supplied.result.diagnostics?.capture_receipt))
      .toBe(JSON.stringify(captureOff.result.diagnostics?.capture_receipt));
    expect(JSON.stringify(supplied.result.diagnostics?.capture_receipt))
      .toBe(JSON.stringify(unavailable.result.diagnostics?.capture_receipt));
    expect(supplied.result.diagnostics?.token_economy.embedding_inference_calls).toBe(0);
    expect(captureOff.result.diagnostics?.token_economy.embedding_inference_calls).toBe(0);
    expect(supplied.searchByKeywordField).toHaveBeenCalledTimes(
      captureOff.searchByKeywordField.mock.calls.length
    );
    expect(supplied.searchByKeywordField).toHaveBeenCalledTimes(
      unavailable.searchByKeywordField.mock.calls.length
    );
  });

  it("rejects the reserved unavailable base-store digest on the live recall path", async () => {
    await expect(recallWithLexicalDiagnostic(
      unavailableProducerDigest("base_store"),
      true
    )).rejects.toMatchObject({ code: "malformed_digest" });
  });

  it("seals request and workspace from the retrieval bundle without inventing a snapshot", async () => {
    const receipt = truncatedReceipt();
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "stable",
      captureProof: true,
      memoryRepo: stubMemoryRepo(async () => fieldResult(receipt))
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "stable",
      limit: receipt.merge_limit,
      scope: {}
    });
    const sealed = bundle.memoryLexicalBoundProofs()[0];
    if (sealed === undefined || sealed.status !== "captured") {
      throw new Error("expected sealed bound proof");
    }
    expect(sealed.identity.workspace_id).toBe("workspace-1");
    expect(sealed.identity.request_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(bundle.memoryLexicalRequestPins()).toEqual([{
      workspace_id: "workspace-1",
      request_digest: sealed.identity.request_digest,
      field_prefix: "lexical_relaxed",
      candidate_key_domain: "memory_object_id"
    }]);
    expect(sealed.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
    expect(sealed.field_prefix).toBe("lexical_relaxed");
    expect(sealed.candidate_key_domain).toBe("memory_object_id");
    expect(sealed.receipt.lanes.find((lane) => lane.lane_id === "porter")?.rows)
      .toHaveLength(3);
    verifyLexicalBoundProof(sealed);
  });

  it("emits proof_absent when the relaxed field has no sibling", async () => {
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "stable",
      captureProof: true,
      memoryRepo: stubMemoryRepo(async () => fieldResult(truncatedReceipt(), false))
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "stable",
      limit: 2,
      scope: {}
    });
    const absent = bundle.memoryLexicalBoundProofs()[0];
    expect(absent?.status).toBe("proof_absent");
    expect(absent).toMatchObject({
      evaluated_universe: {
        status: "unavailable",
        reason: "candidate_universe_not_proved"
      },
      observed_candidate_keys: { status: "unavailable", reason: "proof_absent" },
      field_prefix: { status: "unavailable", reason: "field_prefix_not_sealed" },
      candidate_key_domain: {
        status: "unavailable",
        reason: "candidate_key_domain_not_sealed"
      }
    });
    expect(Array.isArray(absent?.evaluated_universe)).toBe(false);
  });

  it("sends a named explicit capture and source-seals every retained receipt", async () => {
    const searchByKeywordField = vi.fn(async (
      _workspaceId: string,
      queryText: string,
      _limit: number,
      _scope?: unknown,
      _refinementDepths?: unknown,
      _capture?: unknown
    ) => {
      const receipt = queryText === "expanded" ? completeReceipt() : truncatedReceipt();
      return fieldResult(receipt);
    });
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "stable",
      captureProof: true,
      memoryRepo: stubMemoryRepo(searchByKeywordField)
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "relaxed",
      limit: 2,
      scope: {}
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_expanded",
      queryText: "expanded",
      limit: 10,
      scope: {}
    });
    expect(searchByKeywordField).toHaveBeenNthCalledWith(
      1, "workspace-1", "relaxed", 2, {}, undefined, { variant: "lexical_relaxed" }
    );
    expect(searchByKeywordField).toHaveBeenNthCalledWith(
      2, "workspace-1", "expanded", 10, {}, undefined, { variant: "lexical_expanded" }
    );
    const proofs = bundle.memoryLexicalBoundProofs();
    expect(proofs).toHaveLength(2);
    expect(proofs.every((proof) => proof.status === "captured")).toBe(true);
    expect(proofs.map((proof) =>
      proof.status === "captured" ? proof.field_prefix : undefined
    )).toEqual(["lexical_relaxed", "lexical_expanded"]);
    expect(proofs.map((proof) =>
      proof.status === "captured" ? proof.receipt.query_run_id : undefined
    )).toEqual([
      truncatedReceipt().query_run_id,
      completeReceipt().query_run_id
    ]);
    expect(proofs[0]?.identity.workspace_id).toBe("workspace-1");
    expect(proofs[1]?.identity.workspace_id).toBe("workspace-1");
    expect(new Set(proofs.map((proof) =>
      proof.status === "captured" ? proof.receipt.query_run_id : ""
    )).size).toBe(2);
  });

  it("keeps normal calls bare while explicit diagnostics retain their capture argument", async () => {
    for (const diagnosticCapture of ["answer_features", "packet_trace"] as const) {
      const normalResult = fieldResult(truncatedReceipt());
      const offSearch = vi.fn(async () => normalResult);
      const onSearch = vi.fn(async () => normalResult);
      const offBundle = createRecallRetrievalFieldBundle({
        workspaceId: "workspace-1",
        queryText: "stable",
        memoryRepo: stubMemoryRepo(offSearch)
      });
      const onBundle = createRecallRetrievalFieldBundle({
        workspaceId: "workspace-1",
        queryText: "stable",
        ...(capturesRecallAnswerFeatures(diagnosticCapture) ? { captureProof: true } : {}),
        memoryRepo: stubMemoryRepo(onSearch)
      });
      const request = {
        variant: "lexical_relaxed",
        queryText: "stable",
        limit: 2,
        scope: {}
      } as const;
      const offFirst = await offBundle.searchMemoryKeyword(request);
      const offSecond = await offBundle.searchMemoryKeyword(request);
      const onFirst = await onBundle.searchMemoryKeyword(request);
      const onSecond = await onBundle.searchMemoryKeyword(request);
      expect(offSearch.mock.calls).toEqual([["workspace-1", "stable", 2, {}]]);
      expect(onSearch.mock.calls).toEqual([[
        "workspace-1", "stable", 2, {}, undefined, { variant: "lexical_relaxed" }
      ]]);
      expect([onFirst, onSecond]).toEqual([offFirst, offSecond]);
      expect(offBundle.memoryLexicalBoundProofs()).toEqual([]);
      const sealed = onBundle.memoryLexicalBoundProofs()[0];
      expect(sealed?.status).toBe("captured");
      expect(sealed?.field_prefix).toBe("lexical_relaxed");
    }
  });

  it("does not collect proofs or send capture-proof on the production path", async () => {
    const searchByKeywordField = vi.fn(async () => fieldResult(truncatedReceipt()));
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "stable",
      memoryRepo: stubMemoryRepo(searchByKeywordField)
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "stable",
      limit: 2,
      scope: {}
    });
    expect(searchByKeywordField).toHaveBeenCalledWith("workspace-1", "stable", 2, {});
    expect(bundle.memoryLexicalBoundProofs()).toEqual([]);
  });

  it("does not invent a snapshot when capture-proof is off", async () => {
    const searchByKeywordField = vi.fn(async () => fieldResult(truncatedReceipt()));
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "stable",
      memoryRepo: stubMemoryRepo(searchByKeywordField)
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "stable",
      limit: 2,
      scope: {}
    });
    expect(searchByKeywordField).toHaveBeenCalledWith("workspace-1", "stable", 2, {});
    expect(bundle.memoryLexicalBoundProofs()).toEqual([]);
  });

  it("source-seals an explicit capture against the supplied prepared vector", async () => {
    const searchByKeywordField = vi.fn(async () => fieldResult(truncatedReceipt()));
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "stable",
      captureProof: true,
      memoryRepo: stubMemoryRepo(searchByKeywordField)
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "stable",
      limit: 2,
      scope: {}
    });
    expect(searchByKeywordField).toHaveBeenCalledWith(
      "workspace-1", "stable", 2, {}, undefined, { variant: "lexical_relaxed" }
    );
    const vectorDigest = `sha256:${"a".repeat(64)}` as const;
    const sealed = bundle.memoryLexicalBoundProofsForSnapshot(vectorDigest)[0];
    if (sealed === undefined || sealed.status !== "captured") {
      throw new Error("expected sealed bound proof");
    }
    expect(sealed.identity.snapshot_digest).toBe(vectorDigest);
    expect(sealed.evaluated_universe).toEqual({
      status: "unavailable",
      reason: "candidate_universe_not_proved"
    });
    const capture = bundle.captures()[0];
    expect(capture?.source_snapshot_digest).not.toBe(sealed.identity.request_digest);
    verifyLexicalBoundProof(sealed);
  });
});

async function recallWithLexicalDiagnostic(
  snapshotDigest: `sha256:${string}` | undefined,
  captureAnswerFeatures: boolean
) {
  const memory = createMemoryEntry({
    object_id: "p1",
    content: "The stable operator fact is p1."
  });
  const { dependencies } = createDependencies([memory]);
  const searchByKeywordField = vi.fn(async () => fieldResult(truncatedReceipt()));
  const service = new RecallService({
    ...dependencies,
    memoryRepo: { ...dependencies.memoryRepo, searchByKeywordField }
  });
  const result = await service.recall({
    taskSurface: { ...createTaskSurface(), display_name: "stable" },
    workspaceId: "workspace-1",
    strategy: "analyze",
    ...(captureAnswerFeatures ? { diagnosticCapture: "answer_features" as const } : {}),
    ...(snapshotDigest === undefined ? {} : { snapshotDigest })
  });
  return { result, searchByKeywordField };
}
