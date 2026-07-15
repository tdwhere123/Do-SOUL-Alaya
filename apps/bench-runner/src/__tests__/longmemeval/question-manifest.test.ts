import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import {
  applyQuestionManifest,
  computeQuestionIdDigest,
  createStratifiedQuestionManifest,
  parseQuestionManifest
} from "../../longmemeval/selection/question-manifest.js";

const DATASET_SHA = "a".repeat(64);

function question(id: string, type: string): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: type,
    question: id,
    answer: id,
    question_date: "2026-01-01",
    haystack_session_ids: [],
    haystack_dates: [],
    haystack_sessions: [],
    answer_session_ids: []
  };
}

describe("LongMemEval question manifests", () => {
  it("selects deterministically and restores dataset order before windowing", () => {
    const questions = [
      question("u-1", "single-session-user"),
      question("m-1_abs", "multi-session"),
      question("m-2", "multi-session"),
      question("u-2", "single-session-user"),
      question("m-3", "multi-session"),
      question("u-3_abs", "single-session-user")
    ];
    const manifest = createStratifiedQuestionManifest({
      variant: "longmemeval_s",
      datasetSha256: DATASET_SHA,
      questions,
      targetCount: 4
    });

    expect(
      createStratifiedQuestionManifest({
        variant: "longmemeval_s",
        datasetSha256: DATASET_SHA,
        questions,
        targetCount: 4
      })
    ).toEqual(manifest);
    expect(
      applyQuestionManifest(questions, manifest, {
        variant: "longmemeval_s",
        datasetSha256: DATASET_SHA
      }).map((item) => item.question_id)
    ).toEqual(
      questions
        .filter((item) => manifest.question_ids.includes(item.question_id))
        .map((item) => item.question_id)
    );
  });

  it("rejects duplicate and unknown question ids", () => {
    const questions = [
      question("q-1", "multi-session"),
      question("q-2", "multi-session")
    ];
    const manifest = createStratifiedQuestionManifest({
      variant: "longmemeval_s",
      datasetSha256: DATASET_SHA,
      questions,
      targetCount: 2
    });
    expect(() =>
      applyQuestionManifest(
        questions,
        {
          ...manifest,
          question_ids: ["q-1", "q-1"],
          selected_id_digest: computeQuestionIdDigest(["q-1", "q-1"])
        },
        { variant: "longmemeval_s", datasetSha256: DATASET_SHA }
      )
    ).toThrow(/unique/u);
    expect(() =>
      applyQuestionManifest(
        questions,
        {
          ...manifest,
          question_ids: ["q-1", "missing"],
          selected_id_digest: computeQuestionIdDigest(["q-1", "missing"])
        },
        { variant: "longmemeval_s", datasetSha256: DATASET_SHA }
      )
    ).toThrow(/unknown/);
  });

  it("rejects schema, binding, digest, and quota drift", () => {
    const questions = [
      question("q-1", "multi-session"),
      question("q-2_abs", "multi-session")
    ];
    const manifest = createStratifiedQuestionManifest({
      variant: "longmemeval_s",
      datasetSha256: DATASET_SHA,
      questions,
      targetCount: 2
    });
    expect(() => parseQuestionManifest({ ...manifest, schema_version: 2 })).toThrow(
      /schema invalid/u
    );
    expect(() =>
      applyQuestionManifest(questions, manifest, {
        variant: "longmemeval_m",
        datasetSha256: DATASET_SHA
      })
    ).toThrow(/variant mismatch/u);
    expect(() =>
      applyQuestionManifest(
        questions,
        { ...manifest, selected_id_digest: "f".repeat(64) },
        { variant: "longmemeval_s", datasetSha256: DATASET_SHA }
      )
    ).toThrow(/digest mismatch/u);
    expect(() =>
      applyQuestionManifest(
        questions,
        { ...manifest, abstention_count: 0 },
        { variant: "longmemeval_s", datasetSha256: DATASET_SHA }
      )
    ).toThrow(/abstention count/u);
  });

  it("requires exact quota key sets even when omitted or extra keys are zero", () => {
    const questions = [
      question("q-1", "multi-session"),
      question("q-2_abs", "multi-session"),
      question("q-3", "temporal-reasoning")
    ];
    const manifest = createStratifiedQuestionManifest({
      variant: "longmemeval_s",
      datasetSha256: DATASET_SHA,
      questions,
      targetCount: 2
    });
    const expected = { variant: "longmemeval_s" as const, datasetSha256: DATASET_SHA };

    expect(() => applyQuestionManifest(questions, {
      ...manifest,
      joint_quotas: manifest.joint_quotas.slice(1)
    }, expected)).toThrow(/joint quota key set/u);
    expect(() => applyQuestionManifest(questions, {
      ...manifest,
      joint_quotas: [
        ...manifest.joint_quotas,
        { question_type: "forged", answerability: "answerable", count: 0 }
      ]
    }, expected)).toThrow(/joint quota key set/u);
    const { "temporal-reasoning": _omitted, ...missingType } = manifest.type_quotas;
    expect(() => applyQuestionManifest(questions, {
      ...manifest,
      type_quotas: missingType
    }, expected)).toThrow(/type quota key set/u);
    expect(() => applyQuestionManifest(questions, {
      ...manifest,
      type_quotas: { ...manifest.type_quotas, forged: 0 }
    }, expected)).toThrow(/type quota key set/u);
  });

  it("keeps the tracked 100Q manifest bound to the pinned metadata", async () => {
    const root = resolve(import.meta.dirname, "../../../../..");
    const manifest = parseQuestionManifest(JSON.parse(await readFile(
      resolve(root, "docs/bench-history/datasets/longmemeval_s.stratified-100.v1.json"),
      "utf8"
    )));
    const metaRaw = await readFile(
      resolve(root, "docs/bench-history/datasets/longmemeval_s.meta.json"),
      "utf8"
    );
    const meta = JSON.parse(metaRaw) as { sha256: string };
    expect(manifest.dataset_sha256).toBe(meta.sha256);
    expect(manifest.target_count).toBe(100);
    expect(manifest.abstention_count).toBe(6);
    expect(manifest.question_ids).toHaveLength(100);
    expect(new Set(manifest.question_ids).size).toBe(100);
    expect(manifest.type_quotas).toEqual({
      "knowledge-update": 16,
      "multi-session": 27,
      "single-session-assistant": 11,
      "single-session-preference": 6,
      "single-session-user": 14,
      "temporal-reasoning": 26
    });
    expect(manifest.joint_quotas.reduce((sum, quota) => sum + quota.count, 0)).toBe(100);
    expect(manifest.joint_quotas
      .filter((quota) => quota.answerability === "abstention")
      .reduce((sum, quota) => sum + quota.count, 0)).toBe(6);
    expect(manifest.selected_id_digest).toBe(computeQuestionIdDigest(manifest.question_ids));
  });
});
