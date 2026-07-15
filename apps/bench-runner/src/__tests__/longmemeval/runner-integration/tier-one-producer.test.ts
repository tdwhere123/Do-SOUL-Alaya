import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifiedLongMemEvalEvidenceMatches,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  summarizeProviderStates,
  type LongMemEvalDiagnosticsSidecar,
  type LongMemEvalQuestionDiagnostic
} from "../../../longmemeval/diagnostics.js";
import {
  createLongMemEvalSelectionContract
} from "../../../longmemeval/selection/contract.js";

const provenance = vi.hoisted(() => ({ sidecar: vi.fn() }));

vi.mock("../../../longmemeval/provenance/run.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/provenance/run.js")>(),
  buildLongMemEvalRunProvenanceSidecar: provenance.sidecar
}));

import { writeTierOneLongMemEvalArchive } from
  "../../../longmemeval/archive/tier-one-evidence.js";
import { buildVerifiedPriorArchivePayload } from
  "../longmemeval-runner-fixture.js";
import {
  buildVerifiedQuestionDiagnostic,
  createVerifiedHistoryAuthority,
  writeVerifiedHistoryArchive
} from "../verified-history-archive-fixture.js";
import { buildRunnerQuestions, readJson } from "./fixture.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "tier-one-producer-"));
  provenance.sidecar.mockReset();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

it("promotes verified current evidence after a real release-size prior", async () => {
  const fixture = buildProducerFixture();
  expect(fixture.prior.kpi.tier_distribution).toEqual({ hot: 0, warm: 500, cold: 0 });
  expect(fixture.prior.kpi.degradation_reasons.none).toBe(500);
  const authority = createVerifiedHistoryAuthority({
    historyRoot: fixture.historyRoot,
    datasetSha256: fixture.datasetSha256,
    questions: fixture.questions
  });
  await writeVerifiedHistoryArchive({
    layout: authority.layout,
    slug: "2026-05-15T120000Z-aaa1111",
    payload: fixture.prior
  });
  provenance.sidecar.mockResolvedValue(completeProvenanceSidecar(fixture.current));

  const result = await writeTierOneLongMemEvalArchive({
    ...fixture.archiveInput,
    releaseEvidenceAuthority: authority.releaseEvidenceAuthority
  });

  expect(result.payload.diff_vs_previous?.previous_run).toBe(fixture.prior.run_at);
  expect(verifiedLongMemEvalEvidenceMatches(
    result.payload,
    result.evidenceContext
  )).toBe(true);
  const latestPassing = await readJson<{ slug: string }>(join(
    fixture.historyRoot,
    "public-multiturn",
    "latest-passing.json"
  ));
  expect(latestPassing.slug).toBe(result.slug);
  await expect(readFile(join(
    fixture.historyRoot,
    "public-crossquestion",
    "latest-run.json"
  ), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a payload whose bench identity differs from its pointer tree", async () => {
  const fixture = buildProducerFixture();
  provenance.sidecar.mockResolvedValue(completeProvenanceSidecar(fixture.current));

  await expect(writeTierOneLongMemEvalArchive({
    ...fixture.archiveInput,
    benchName: "public-crossquestion",
    releaseEvidenceAuthority: null
  })).rejects.toThrow(/bench identity/iu);
  await expect(readFile(join(
    fixture.historyRoot,
    "public-crossquestion",
    "latest-run.json"
  ), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

function buildProducerFixture() {
  const questions = buildRunnerQuestions("q-release-", 500);
  const datasetSha256 = createHash("sha256")
    .update(JSON.stringify(questions), "utf8")
    .digest("hex");
  const historyRoot = join(tmpRoot, "history");
  const prior = releasePayload(questions, datasetSha256, "2026-05-15T12:00:00.000Z", "aaa1111");
  const current = releasePayload(questions, datasetSha256, "2026-05-16T12:00:00.000Z", "bbb2222");
  const diagnostics = questions.map((question) => releaseDiagnostic(question.question_id));
  const selectionContract = createLongMemEvalSelectionContract({
    datasetSha256,
    questions
  });
  return {
    questions,
    datasetSha256,
    historyRoot,
    prior,
    current,
    archiveInput: {
      benchName: "public-multiturn" as const,
      opts: { variant: "longmemeval_s" as const, historyRoot, extractionCacheRoot: "/cache" },
      datasetSha256,
      datasetChecksumSource: "/fixture/longmemeval_s.meta.json",
      datasetSourcePath: "/fixture/longmemeval_s.json",
      selectionContract,
      payload: current,
      diagnosticsPayload: diagnosticsPayload(current, diagnostics),
      releaseDiagnostics: diagnostics,
      commitSha7: current.alaya_commit,
      embeddingProviderLabel: "none",
      runAt: new Date(current.run_at)
    }
  };
}

function releasePayload(
  questions: ReturnType<typeof buildRunnerQuestions>,
  datasetSha256: string,
  runAt: string,
  commitSha7: string
) {
  return buildVerifiedPriorArchivePayload({
    benchName: "public-multiturn",
    datasetName: "longmemeval_s:multiturn",
    datasetSha256,
    questions,
    runAt,
    commitSha7
  });
}

function releaseDiagnostic(questionId: string): LongMemEvalQuestionDiagnostic {
  return buildVerifiedQuestionDiagnostic({
    id: questionId,
    version: 1,
    hit_at_5: true,
    scorable: true,
    measurement_cohort: "answerable",
    tier: "warm"
  });
}

function diagnosticsPayload(
  payload: KpiPayload,
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): LongMemEvalDiagnosticsSidecar {
  return {
    schema_version: 1,
    bench_name: "public-multiturn",
    split: payload.split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    embedding_provider: payload.embedding_provider,
    embedding_mode: "disabled",
    seed_extraction_path: payload.kpi.seed_extraction_path,
    provider_state_summary: summarizeProviderStates(diagnostics),
    questions: diagnostics
  };
}

function completeProvenanceSidecar(payload: KpiPayload) {
  return {
    filename: "longmemeval-run-provenance.json",
    contents: `${JSON.stringify(completeProvenance(payload), null, 2)}\n`
  };
}

function completeProvenance(payload: KpiPayload) {
  const datasetSha256 = payload.dataset.checksum_sha256!;
  return {
    schema_version: 1,
    dataset_sha256: datasetSha256,
    selection: payload.selection_contract,
    code: completeCode(payload.alaya_commit),
    extraction_cache: completeCache(datasetSha256, payload.evaluated_count),
    runtime: completeRuntime(),
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: payload.evaluated_count,
      evaluated_count: payload.evaluated_count
    },
    recall_config: {
      conf_slice_compatibility: false,
      schema_version: 2,
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "d".repeat(64)
    },
    seed_capabilities: { facet_tags_enabled: false },
    question_manifest: null
  };
}

function completeCode(commitSha7: string) {
  return {
    commit_sha7: commitSha7,
    commit_sha: `${commitSha7}${"0".repeat(40 - commitSha7.length)}`,
    gate_sha256: "a".repeat(64),
    gate_contract_path: "/fixture/gate.json",
    worktree_state_sha256: "b".repeat(64),
    worktree_clean: true,
    executed_dist: {
      algorithm: "sha256-reachable-path-file-sha256-v1",
      sha256: "c".repeat(64),
      file_count: 1
    }
  };
}

function completeCache(datasetSha256: string, count: number) {
  return {
    schema_version: 3,
    manifest_sha256: "e".repeat(64),
    extraction_model: "test-model",
    model_family: "test-model",
    request_profile: "provider-default-v1",
    provider_url: "sha256:" + "f".repeat(64),
    system_prompt_sha256: "1".repeat(64),
    cache_key_algo: "sha256-model-profile-prompt-content-v3",
    dataset: "longmemeval-s",
    dataset_revision: datasetSha256,
    requested_turns: count,
    cached_turns: count,
    coverage: 1,
    storage: "git-tracked",
    built_at: "2026-07-16T00:00:00.000Z",
    builder: "test"
  };
}

function completeRuntime() {
  return {
    node_version: "v24.0.0",
    platform: "linux",
    arch: "x64",
    embedding_mode: "disabled",
    embedding_provider_kind: "openai",
    embedding_provider_label: "none",
    onnx_threads: null,
    embedding_supplement: { enabled: false },
    answer_rerank: { enabled: false },
    paired_env: {}
  };
}
