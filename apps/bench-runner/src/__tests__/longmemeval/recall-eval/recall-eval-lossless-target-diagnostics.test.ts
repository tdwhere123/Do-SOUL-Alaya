import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createStratifiedQuestionManifest,
  applyQuestionManifest,
  parseQuestionManifest
} from "../../../runs/selection/question-manifest.js";

describe("fixed selection manifest", () => {
  describe("Fixed 20Q / 100Q Selections and Pre-Outcome Immutability", () => {
    const DATASET_PATH = "apps/bench-runner/data/longmemeval/longmemeval_s.json";
    const DATASET_SHA = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
    const FIXTURE_SHA = "a".repeat(64);
    const fixtureQuestions = Array.from({ length: 24 }, (_, index) => ({
      question_id: index === 23 ? "q-23_abs" : `q-${index}`,
      question_type: index % 2 === 0 ? "multi-session" : "single-session-user",
      question: `q-${index}`,
      answer: `a-${index}`,
      question_date: "2026-01-01",
      haystack_session_ids: [] as string[],
      haystack_dates: [] as string[],
      haystack_sessions: [] as never[],
      answer_session_ids: [] as string[]
    }));

    it("recomputes a 20Q manifest identically across two calls", () => {
      const first = createStratifiedQuestionManifest({
        variant: "longmemeval_s",
        datasetSha256: FIXTURE_SHA,
        questions: fixtureQuestions,
        targetCount: 20
      });
      const second = createStratifiedQuestionManifest({
        variant: "longmemeval_s",
        datasetSha256: FIXTURE_SHA,
        questions: fixtureQuestions,
        targetCount: 20
      });
      expect(second).toEqual(first);
      expect(first.target_count).toBe(20);
      const selected = applyQuestionManifest(fixtureQuestions, first, {
        variant: "longmemeval_s",
        datasetSha256: FIXTURE_SHA
      });
      expect(selected).toHaveLength(20);
    });

    it.skipIf(!existsSync(DATASET_PATH))(
      "deterministically reproduces 100Q manifest matching frozen stratified-100.v1.json",
      () => {
        const datasetRaw = JSON.parse(readFileSync(DATASET_PATH, "utf8"));
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
      }
    );

    it("fails closed on manifest dataset SHA drift, quota drift, or unknown IDs", () => {
      const frozen20 = createStratifiedQuestionManifest({
        variant: "longmemeval_s",
        datasetSha256: FIXTURE_SHA,
        questions: fixtureQuestions,
        targetCount: 20
      });

      // Dataset SHA mismatch
      expect(() =>
        applyQuestionManifest(fixtureQuestions, frozen20, {
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
        applyQuestionManifest(fixtureQuestions, tampered, {
          variant: "longmemeval_s",
          datasetSha256: FIXTURE_SHA
        })
      ).toThrow(/unknown id|digest mismatch/u);
    });
  });
});
