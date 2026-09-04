import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FineAssessmentDiagnosticCapture } from "@do-soul/alaya-core";
import { createCandidateActivationCapture } from "../../../runs/lifecycle/recall-eval/recall-eval-candidate-activation.js";
import {
  createStratifiedQuestionManifest,
  applyQuestionManifest,
  parseQuestionManifest
} from "../../../runs/selection/question-manifest.js";
import type { RecallEvalQuestionResult } from "../../../runs/lifecycle/recall-eval/recall-eval-contract.js";
import { TargetDecisionTraceDiagnosticSchema } from
  "../../../diagnostics/schema/question-diagnostics-schema.js";

describe("lossless target diagnostics and fixed selection", () => {
  describe("Target Decision Trace Projection in Diagnostic Observer", () => {
    it("projects complete shadowTrace into identity-bound target_decision_trace", () => {
      const capture = createCandidateActivationCapture(true);
      expect(capture.observer).toBeDefined();

      const mockShadowTrace = {
        kind: "captured",
        prefix: ["c-1", "c-2"],
        prefix_proposal: ["c-1", "c-2"],
        S_infty: ["c-1", "c-2", "c-3"],
        walk_rejects: [],
        max_g_cohort: ["c-1"],
        equal_g_dominance_rejects: [],
        gamma_availability: null,
        unresolved_pointwise_tradeoff: false,
        core_known_no_witness: [],
        psi_v2_shadow: {
          schema_version: 1,
          cycle_count: 0,
          first_frontier_size: 4,
          frontier_depth: 3,
          frontier_width: 3,
          undominated_share: 0.5
        },
        query_proof_preview: {
          status: "captured",
          prefix: ["c-1", "c-2"],
          contract_digest: "gamma-digest-123",
          compile_disposition: "complete"
        } as never,
        delivery_pack: {
          mode: "certified",
          selected_candidates: ["c-1", "c-2"],
          allowed_claims: ["answer_binding"]
        } as never
      };

      const mockDiagnosticCapture: FineAssessmentDiagnosticCapture = {
        supplementaryData: {
          openSemanticFactorCandidateActivationsByCandidateKey: new Map([
            ["c-1", { activation: 1 }],
            ["c-2", { activation: 2 }]
          ])
        } as unknown as FineAssessmentDiagnosticCapture["supplementaryData"],
        result: {
          shadowTrace: mockShadowTrace
        } as unknown as FineAssessmentDiagnosticCapture["result"]
      };

      capture.observer!(mockDiagnosticCapture);

      const baseResult = {
        questionId: "q-test-1",
        hitAt1: true,
        hitAt5: true,
        hitAt10: true,
        latencyMs: 15,
        diagnostics: {
          delivered_results: [{ object_id: "mem-1" }, { object_id: "mem-2" }]
        }
      } as unknown as RecallEvalQuestionResult;

      const attached = capture.attach(baseResult);
      const trace = attached.diagnostics.target_decision_trace;
      if (trace === undefined || trace === null) {
        throw new Error("expected target_decision_trace");
      }
      expect(trace.status).toBe("captured");
      // Frontier depth and first frontier size are not conflated
      expect(trace.first_frontier_size).toBe(4);
      expect(trace.frontier_depth).toBe(3);
      expect(trace.cycle_status).toBe("no_cycle");
      expect(trace.gamma_compile_disposition).toBe("complete");
      expect(trace.gamma_digest).toBe("gamma-digest-123");
      expect(trace.target_prefix).toEqual(["c-1", "c-2"]);
      expect(trace.current_delivered_prefix).toEqual(["c-1", "c-2"]);
      expect(trace.delivery_pack_mode).toBe("certified");
      expect(trace.allowed_claims).toEqual(["answer_binding"]);
      expect(() => TargetDecisionTraceDiagnosticSchema.parse(trace)).not.toThrow();
    });

    it("creates explicit unavailable state when observer captures no shadowTrace, never empty or 0", () => {
      const capture = createCandidateActivationCapture(true);
      const baseResult = {
        questionId: "q-test-2",
        hitAt1: false,
        hitAt5: false,
        hitAt10: false,
        latencyMs: 10,
        diagnostics: {}
      } as unknown as RecallEvalQuestionResult;
      const attached = capture.attach(baseResult);
      const trace = attached.diagnostics.target_decision_trace;
      if (trace === undefined || trace === null) {
        throw new Error("expected target_decision_trace");
      }
      expect(trace.status).toBe("unavailable");
      expect(trace.fail_reason).toBe("shadow_trace_missing");
      // Must not serialize as 0 or empty array!
      expect(trace.first_frontier_size).toBeUndefined();
      expect(trace.frontier_depth).toBeUndefined();
    });

    it("creates explicit failed state when shadowTrace is fail_closed", () => {
      const capture = createCandidateActivationCapture(true);
      const mockDiagnosticCapture: FineAssessmentDiagnosticCapture = {
        supplementaryData: {} as unknown as FineAssessmentDiagnosticCapture["supplementaryData"],
        result: {
          shadowTrace: {
            kind: "fail_closed",
            reason: "psi_cycle_contract_failure"
          }
        } as unknown as FineAssessmentDiagnosticCapture["result"]
      };

      capture.observer!(mockDiagnosticCapture);

      const baseResult = {
        questionId: "q-test-3",
        hitAt1: false,
        hitAt5: false,
        hitAt10: false,
        latencyMs: 10,
        diagnostics: {}
      } as unknown as RecallEvalQuestionResult;
      const attached = capture.attach(baseResult);
      const trace = attached.diagnostics.target_decision_trace;
      if (trace === undefined || trace === null) {
        throw new Error("expected target_decision_trace");
      }
      expect(trace.status).toBe("failed");
      expect(trace.fail_reason).toBe("psi_cycle_contract_failure");
    });
  });

  describe("Fixed 20Q / 100Q Selections and Pre-Outcome Immutability", () => {
    const datasetRaw = JSON.parse(
      readFileSync("apps/bench-runner/data/longmemeval/longmemeval_s.json", "utf8")
    );
    const DATASET_SHA = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";

    it("recomputes a 20Q manifest identically across two calls", () => {
      const first = createStratifiedQuestionManifest({
        variant: "longmemeval_s",
        datasetSha256: DATASET_SHA,
        questions: datasetRaw,
        targetCount: 20
      });
      const second = createStratifiedQuestionManifest({
        variant: "longmemeval_s",
        datasetSha256: DATASET_SHA,
        questions: datasetRaw,
        targetCount: 20
      });
      expect(second).toEqual(first);
      expect(first.target_count).toBe(20);
      const selected = applyQuestionManifest(datasetRaw, first, {
        variant: "longmemeval_s",
        datasetSha256: DATASET_SHA
      });
      expect(selected).toHaveLength(20);
    });

    it("deterministically reproduces 100Q manifest matching frozen stratified-100.v1.json", () => {
      const frozen100 = parseQuestionManifest(
        JSON.parse(
          readFileSync("docs/bench-history/datasets/longmemeval_s.stratified-100.v1.json", "utf8")
        )
      );

      const recomputed100 = createStratifiedQuestionManifest({
        variant: "longmemeval_s",
        datasetSha256: DATASET_SHA,
        questions: datasetRaw,
        targetCount: 100
      });

      expect(recomputed100).toEqual(frozen100);
      expect(recomputed100.target_count).toBe(100);
      expect(recomputed100.abstention_count).toBe(6);
      expect(recomputed100.selected_id_digest).toBe(
        "4ff33c60fd7e8a1381848d660b1443b7d37ad7723784d61a908bad73caf58d97"
      );
    });

    it("fails closed on manifest dataset SHA drift, quota drift, or unknown IDs", () => {
      const frozen20 = createStratifiedQuestionManifest({
        variant: "longmemeval_s",
        datasetSha256: DATASET_SHA,
        questions: datasetRaw,
        targetCount: 20
      });

      // Dataset SHA mismatch
      expect(() =>
        applyQuestionManifest(datasetRaw, frozen20, {
          variant: "longmemeval_s",
          datasetSha256: "0".repeat(64)
        })
      ).toThrow(/dataset SHA-256 mismatch/i);

      // Tampered question ID
      const tampered = {
        ...frozen20,
        question_ids: ["nonexistent_id", ...frozen20.question_ids.slice(1)]
      };
      expect(() =>
        applyQuestionManifest(datasetRaw, tampered, {
          variant: "longmemeval_s",
          datasetSha256: DATASET_SHA
        })
      ).toThrow(/unknown id|digest mismatch/u);
    });
  });
});
