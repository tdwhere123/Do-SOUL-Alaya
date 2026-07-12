import { describe, expect, it } from "vitest";
import type { LongMemEvalQuestion } from "../../../longmemeval/dataset.js";
import {
  assertLegacySnapshotManifest,
  hydrateLegacySnapshotSidecar
} from "../../../longmemeval/snapshot/legacy-substrate.js";

const question = {
  question_id: "question-1",
  question_type: "single-session-user",
  question: "What did I choose?",
  answer: "tea",
  question_date: "2026-01-02T03:04:05.000Z",
  haystack_session_ids: ["session-1"],
  haystack_dates: ["2026-01-01T00:00:00.000Z"],
  haystack_sessions: [[{ role: "user", content: "I chose tea.", has_answer: true }]],
  answer_session_ids: ["session-1"]
} satisfies LongMemEvalQuestion;

const sidecar = {
  schema_version: 1,
  variant: "longmemeval_s",
  questions: [{
    questionId: question.question_id,
    question: question.question,
    answerSessionIds: question.answer_session_ids,
    workspaceId: "workspace-1",
    runId: "run-1",
    sidecar: [{
      objectId: "memory-1",
      objectKind: "memory_entry",
      sessionId: "session-1",
      hasAnswer: true
    }]
  }]
};

function legacyManifest() {
  return {
    schema_version: 1,
    recall_pipeline_version: "fusion-rrf-synthesis-v2",
    schema_migration_version: 103,
    bench_runner_version: "0.3.11",
    alaya_commit: "d7266aa",
    variant: "longmemeval_s",
    question_count: 1,
    question_id_digest: "a".repeat(64),
    artifact_integrity: {
      db_sha256: "b".repeat(64),
      sidecar_sha256: "c".repeat(64)
    },
    attribution: { status: "legacy_unattributed", gate_eligible: false },
    extraction_provenance: {
      extraction_model: "deepseek-v4-flash",
      provider_url: "sha256:12b8deaccc34b32757dbb1497e029da0c2e7b26ffa86b9c926c08cb4692f4508",
      system_prompt_sha256: "9d3ad32c33028cd175d0941780f0c45f8357439a8f750c24accfd6385d2226a3",
      dataset: "longmemeval-s",
      dataset_revision: "unpinned",
      requested_turns: 1284,
      cached_turns: 96084,
      coverage: 1
    },
    run_provenance: {
      code: { commit_sha7: "d7266aa", gate_sha256: null, worktree_state_sha256: null },
      extraction_cache: {
        manifest_sha256: "4d62f1ce27e5195081c0968732f47f4fa86963f6d6732e5b3b087b41250a5011",
        schema_version: 1,
        extraction_model: "deepseek-v4-flash",
        provider_url: "sha256:12b8deaccc34b32757dbb1497e029da0c2e7b26ffa86b9c926c08cb4692f4508",
        system_prompt_sha256: "9d3ad32c33028cd175d0941780f0c45f8357439a8f750c24accfd6385d2226a3",
        cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
        dataset: "longmemeval-s",
        dataset_revision: "unpinned",
        requested_turns: 1284,
        cached_turns: 96084,
        coverage: 1,
        storage: "git-tracked",
        builder: "extraction-fill",
        built_at: "2026-07-01T10:38:36.468Z"
      },
      execution: {
        protocol: "sequential",
        concurrency: 1,
        offset: 0,
        limit: 1,
        evaluated_count: 1
      }
    }
  };
}

describe("legacy recall substrate", () => {
  it("hydrates missing question dates only from the bound dataset row", () => {
    expect(hydrateLegacySnapshotSidecar(sidecar, [question])).toEqual({
      schema_version: 2,
      variant: "longmemeval_s",
      questions: [{
        ...sidecar.questions[0],
        questionDate: question.question_date
      }]
    });
  });

  it("rejects a sidecar whose question or answer sessions drifted", () => {
    expect(() => hydrateLegacySnapshotSidecar({
      ...sidecar,
      questions: [{ ...sidecar.questions[0]!, question: "different" }]
    }, [question])).toThrow(/question text mismatch/iu);
    expect(() => hydrateLegacySnapshotSidecar({
      ...sidecar,
      questions: [{ ...sidecar.questions[0]!, answerSessionIds: ["other"] }]
    }, [question])).toThrow(/answer sessions mismatch/iu);
  });

  it("accepts only the pinned ineligible v1 producer contract", () => {
    expect(() => assertLegacySnapshotManifest(legacyManifest())).not.toThrow();
  });

  it("rejects provenance drift or a gate-eligible legacy claim", () => {
    const base = legacyManifest();
    expect(() => assertLegacySnapshotManifest({
      ...base,
      attribution: { status: "attributed", gate_eligible: true }
    })).toThrow(/ineligible/iu);
    expect(() => assertLegacySnapshotManifest({
      ...base,
      run_provenance: { ...base.run_provenance, extraction_cache: {
        ...base.run_provenance.extraction_cache, system_prompt_sha256: "a".repeat(64)
      } }
    })).toThrow(/prompt/iu);
  });

  it("rejects unknown sessions, impossible answer markers, and question order drift", () => {
    expect(() => hydrateLegacySnapshotSidecar({
      ...sidecar,
      questions: [{ ...sidecar.questions[0]!, sidecar: [{
        ...sidecar.questions[0]!.sidecar[0]!, sessionId: "unknown"
      }] }]
    }, [question])).toThrow(/absent from dataset/iu);
    const withoutMarker = {
      ...question,
      haystack_sessions: [[{ role: "user", content: "I chose tea." }]]
    } satisfies LongMemEvalQuestion;
    expect(() => hydrateLegacySnapshotSidecar(sidecar, [withoutMarker])).toThrow(/answer marker/iu);
    expect(() => hydrateLegacySnapshotSidecar(sidecar, [{
      ...question, question_id: "question-2"
    }], legacyManifest())).toThrow(/question order/iu);
  });
});
