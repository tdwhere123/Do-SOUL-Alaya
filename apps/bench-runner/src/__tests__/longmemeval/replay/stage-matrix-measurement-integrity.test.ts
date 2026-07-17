import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// @ts-expect-error The executable MJS analyzer is intentionally outside the package declaration surface.
import { assertCompleteReplayQuestion, loadEvidenceBundle, loadReplayContract, validateEvidenceBundle } from "../../../../scripts/longmemeval-replay/contract.mjs";
// @ts-expect-error The executable MJS analyzer is intentionally outside the package declaration surface.
import { buildStageMatrix, loadStageMatrix, renderStageMatrix } from "../../../../scripts/longmemeval-replay/stage-matrix.mjs";
import { measurementUnscorableReason } from "../../../../scripts/longmemeval-replay/measurement-status.mjs";
import {
  HASH,
  candidate,
  cliPath,
  cohortRow,
  contract,
  execFileAsync,
  qualityAxes,
  question,
  sha,
  writeBundle
} from "./stage-matrix-fixture.js";

describe("LongMemEval stage matrix replay", () => {
  it("rejects abstention quality-axis drift between diagnostics and cohort", () => {
    const cohortAxes = qualityAxes({ abstention: "correct" });
    const row = cohortRow({
      id: "q-abstention-drift", goldIds: [], datasetCohort: "abstention", status: "absent",
      qualityAxes: cohortAxes
    });
    const diagnostic = {
      ...question("q-abstention-drift", [], row),
      quality_axes: { ...cohortAxes, abstention: { applicable: true, status: "false_confident" } }
    };
    expect(() => buildStageMatrix(contract([diagnostic], [row])))
      .toThrow(/quality_axes drift.*q-abstention-drift/u);
  });

  it("classifies the first failure and terminal loss while counting gains and losses", () => {
    const row = cohortRow({ id: "q-loss", goldIds: ["gold-a"] });
    const ranks = {
      fused_rank: 4, rank_after_fusion: 4, feature: 6, lexical: 3,
      coverage: 2, session: 2, synthesis: 2, structural: 7,
      selection_order: 7, final_rank: 7
    };
    const matrix = buildStageMatrix(contract([
      question("q-loss", [candidate("gold-a", ranks), candidate("rank-five", {
        fused_rank: 5, rank_after_fusion: 5, feature: 5, lexical: 5,
        coverage: 5, session: 5, synthesis: 5, structural: 5,
        selection_order: 5, final_rank: 5
      })], row)
    ], [row]));
    expect(matrix.questions[0]).toMatchObject({
      classification: "ranked_miss",
      first_failure: "feature",
      terminal_loss: "structural"
    });
    expect(matrix.summary.transitions).toMatchObject({
      feature: { gains: 0, losses: 1 },
      lexical: { gains: 1, losses: 0 },
      structural: { gains: 0, losses: 1 }
    });
  });

  it("retains unscorable dataset-answerable rows without shrinking denominators silently", () => {
    const row = cohortRow({
      id: "q-unscorable",
      goldIds: [],
      status: "absent",
      issue: "empty_gold_identity"
    });
    const matrix = buildStageMatrix(contract([
      question("q-unscorable", [], row)
    ], [row]));
    expect(matrix.questions[0]).toMatchObject({
      classification: "unscorable",
      unscorable_reason: "empty_gold_identity",
      first_failure: null,
      terminal_loss: null
    });
    expect(matrix.summary).toMatchObject({
      dataset_answerable: 1,
      scorable_answerable: 0,
      unscorable_answerable: 1
    });
    expect(matrix.summary.by_stage.final_rank.at_5.denominator).toBe(0);
  });

  it("rejects a persisted measurement status that contradicts primitive axes", () => {
    const row = cohortRow({
      id: "q-status",
      goldIds: ["gold-a"],
      status: "present",
      measurementStatus: "evaluator_identity_unscorable"
    });
    expect(() => buildStageMatrix(contract([
      question("q-status", [candidate("gold-a", { fused_rank: 1 })], row)
    ], [row]))).toThrow(/measurement status contradicts primitive axes/u);
  });

  it.each([
    ["abstention", "abstention"],
    ["adjudicated", "adjudicated_invalid"]
  ] as const)("rejects a forged %s status before cohort filtering", (
    _label,
    datasetCohort
  ) => {
    const row = {
      ...cohortRow({
        id: `q-${datasetCohort}`,
        goldIds: datasetCohort === "abstention" ? [] : ["gold-a"],
        datasetCohort: datasetCohort === "abstention" ? "abstention" : "answerable",
        status: datasetCohort === "abstention" ? "absent" : "present"
      }),
      dataset_cohort: datasetCohort,
      measurement_status: "scorable"
    };
    expect(() => buildStageMatrix(contract([
      question(row.question_id, [], row as ReturnType<typeof cohortRow>)
    ], [row as ReturnType<typeof cohortRow>]))).toThrow(
      /measurement status contradicts primitive axes/u
    );
  });

  it("rejects a forged status on a cohort-only partial row", () => {
    const complete = cohortRow({ id: "q-complete-status", goldIds: ["gold-a"] });
    const forged = {
      ...cohortRow({
        id: "q-cohort-only-status",
        goldIds: [],
        datasetCohort: "abstention",
        status: "absent",
        measurementStatus: "scorable"
      }),
      evidence_status: "missing",
      candidate_pool_complete: false
    };
    expect(() => buildStageMatrix(contract([
      question("q-complete-status", [candidate("gold-a", { fused_rank: 1 })], complete)
    ], [complete, forged]))).toThrow(/measurement status contradicts primitive axes/u);
  });

  it("rejects malformed measurement primitives before cohort filtering", () => {
    const row = {
      ...cohortRow({
        id: "q-malformed-primitive",
        goldIds: [],
        datasetCohort: "abstention",
        status: "absent"
      }),
      evaluator_gold_identity: { status: "absent", object_ids: "not-an-array" }
    };
    expect(() => buildStageMatrix(contract([
      question(row.question_id, [], row as unknown as ReturnType<typeof cohortRow>)
    ], [row as unknown as ReturnType<typeof cohortRow>]))).toThrow(
      /evaluator_gold_identity\.object_ids/u
    );
  });

  it("rejects a missing materialization primitive before scoring", () => {
    const complete = cohortRow({ id: "q-missing-materialization", goldIds: ["gold-a"] });
    const { extraction_materialization: _missing, ...row } = complete;

    expect(() => buildStageMatrix(contract([
      question(
        row.question_id,
        [candidate("gold-a", { fused_rank: 1 })],
        row as unknown as ReturnType<typeof cohortRow>
      )
    ], [row as unknown as ReturnType<typeof cohortRow>]))).toThrow(
      /extraction_materialization/u
    );
  });

  it("consumes a persisted unscorable status backed by primitive axes", () => {
    const row = cohortRow({
      id: "q-unscorable-status",
      goldIds: [],
      status: "absent",
      measurementStatus: "evaluator_identity_unscorable"
    });
    const matrix = buildStageMatrix(contract([
      question("q-unscorable-status", [], row)
    ], [row]));
    expect(matrix.questions[0]).toMatchObject({
      classification: "unscorable",
      unscorable_reason: "evaluator_identity_unscorable"
    });
    expect(matrix.summary.scorable_answerable).toBe(0);
  });

  it("derives status when current primitives predate the persisted status", () => {
    const row = cohortRow({ id: "q-legacy-status", goldIds: ["gold-a"] });
    delete (row as { measurement_status?: string }).measurement_status;
    const matrix = buildStageMatrix(contract([
      question("q-legacy-status", [candidate("gold-a", { fused_rank: 1 })], row)
    ], [row]));

    expect(matrix.questions[0].classification).toBe("ranked_miss");
    expect(matrix.summary.scorable_answerable).toBe(1);
  });

  it("keeps unstamped abstentions distinct from evaluator identity failures", () => {
    const row = cohortRow({
      id: "q-legacy-abstention",
      goldIds: [],
      datasetCohort: "abstention",
      status: "absent"
    });
    delete (row as { measurement_status?: string }).measurement_status;
    expect(measurementUnscorableReason(row)).toBe("abstention_unscorable");
  });

  it("retains incomplete answerable rows but refuses to score their ranks", async () => {
    const base = cohortRow({ id: "q-partial", goldIds: ["gold-a"] });
    const row = { ...base, evidence_status: "partial", candidate_pool_complete: false };
    const diagnostic = {
      ...question("q-partial", [{ object_id: "gold-a", pre_budget_rank: 1 }], row),
      candidate_pool_complete: false
    };
    const raw = contract([diagnostic], [row]);
    const bundle = await writeBundle(raw, false);
    const loaded = await loadEvidenceBundle(bundle.manifestPath);
    await expect(loadStageMatrix(bundle.manifestPath)).rejects.toThrow(
      /complete evidence manifest/u
    );
    expect(loaded.diagnostics.questions).toHaveLength(1);
    expect(() => assertCompleteReplayQuestion(diagnostic, row)).toThrow(
      /candidate_pool_complete=true.*q-partial/u
    );

    const matrix = buildStageMatrix(loaded);
    expect(matrix.questions[0]).toMatchObject({
      question_id: "q-partial",
      candidate_pool_complete: false,
      classification: "unscorable",
      unscorable_reason: "incomplete_candidate_pool",
      first_failure: null,
      terminal_loss: null
    });
    expect(matrix.questions[0].any_gold_at_k.final_rank[5]).toBeNull();
    expect(matrix.summary).toMatchObject({
      dataset_answerable: 1,
      scorable_answerable: 0,
      unscorable_answerable: 1
    });
  });

  it("reports primitive failures before incomplete candidate-pool symptoms", () => {
    const absent = {
      ...cohortRow({ id: "q-absent-incomplete", goldIds: [], status: "absent" }),
      candidate_pool_complete: false
    };
    const unknown = {
      ...cohortRow({ id: "q-unknown-incomplete", goldIds: ["gold-a"] }),
      measurement_status: "evaluator_identity_unscorable" as const,
      extraction_materialization: {
        status: "unknown" as const, emitted_memory_count: 0, reason: null
      },
      candidate_pool_complete: false
    };
    const questions = [absent, unknown].map((row) => ({
      ...question(row.question_id, [], row),
      candidate_pool_complete: false
    }));

    const matrix = buildStageMatrix(contract(questions, [absent, unknown]));
    expect(matrix.questions.map((row: { unscorable_reason: string }) =>
      row.unscorable_reason
    )).toEqual(["evaluator_identity_unscorable", "evaluator_identity_unscorable"]);
  });

  it("retains cohort-only failed answerable rows in source and answerable denominators", () => {
    const complete = cohortRow({ id: "q-complete", goldIds: ["gold-a"] });
    const failed = {
      ...cohortRow({ id: "q-failed", goldIds: ["gold-b"] }),
      evidence_status: "missing",
      candidate_pool_complete: false,
      evaluation_issue_reason: "missing_diagnostics",
      measurement_status: "evaluator_identity_unscorable" as const
    };
    const matrix = buildStageMatrix(contract([
      question("q-complete", [candidate("gold-a", {
        fused_rank: 1, rank_after_fusion: 1, feature: 1, lexical: 1,
        coverage: 1, session: 1, synthesis: 1, structural: 1,
        selection_order: 1, final_rank: 1
      })], complete)
    ], [complete, failed]));

    expect(matrix.questions).toHaveLength(2);
    expect(matrix.questions[1]).toMatchObject({
      question_id: "q-failed",
      classification: "unscorable",
      unscorable_reason: "missing_diagnostics"
    });
    expect(matrix.summary).toMatchObject({
      source_questions: 2,
      dataset_answerable: 2,
      scorable_answerable: 1,
      unscorable_answerable: 1
    });
  });

  it("rejects contradictory quality axes at the replay boundary", () => {
    const axes = qualityAxes({ coverage: [1, 2] });
    const invalid = {
      ...axes,
      answer_session_coverage_at_5: {
        ...axes.answer_session_coverage_at_5,
        covered_count: 3
      }
    };
    const row = cohortRow({ id: "q-invalid-axes", goldIds: ["gold-a"], qualityAxes: invalid as never });
    expect(() => buildStageMatrix(contract([
      question("q-invalid-axes", [], row)
    ], [row]))).toThrow(/quality_axes.*covered_count/u);
  });

  it("reports fused score margin with explicit rank and facet context deterministically", () => {
    const row = cohortRow({ id: "q-margin", goldIds: ["gold-a"] });
    const gold = candidate("gold-a", {
      fused_rank: 8, rank_after_fusion: 8, feature: 8, lexical: 8,
      coverage: 8, session: 8, synthesis: 8, structural: 8,
      selection_order: 8, final_rank: 8
    });
    const fifth = candidate("rank-five", {
      fused_rank: 5, rank_after_fusion: 5, feature: 5, lexical: 5,
      coverage: 5, session: 5, synthesis: 5, structural: 5,
      selection_order: 5, final_rank: 5
    });
    const matrix = buildStageMatrix(contract([question("q-margin", [fifth, gold], row)], [row]));
    expect(matrix.questions[0].fused_margin).toEqual({
      gold: { object_id: "gold-a", rank: 8, fused_score: 0.4, facet_overlap: 2 },
      rank_five: { object_id: "rank-five", rank: 5, fused_score: 0.5, facet_overlap: 1 },
      gold_minus_rank_five: -0.1
    });
    const rendered = renderStageMatrix(matrix);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(sha(rendered)).toMatch(HASH);
    expect(renderStageMatrix(matrix)).toBe(rendered);
  });

  it("loads the P0 manifest, full diagnostics, and cohort ledger as one contract", async () => {
    const row = cohortRow({ id: "q-load", goldIds: ["gold-a"], retrieval: "hit_at_5" });
    const ranks = {
      fused_rank: 1, rank_after_fusion: 1, feature: 1, lexical: 1,
      coverage: 1, session: 1, synthesis: 1, structural: 1,
      selection_order: 1, final_rank: 1
    };
    const bundle = await writeBundle(contract([
      question("q-load", [candidate("gold-a", ranks)], row)
    ], [row]));
    const loaded = await loadReplayContract(bundle.manifestPath);
    expect(loaded.manifest.run).toMatchObject({ slug: "run-1", candidate_pool_complete: true });
    expect(loaded.diagnostics.questions[0].question_id).toBe("q-load");
    expect(JSON.parse(await readFile(bundle.manifestPath, "utf8")).bundle_sha256).toMatch(HASH);
  });

  it("conforms to the shared canonical question-ID digest contract", async () => {
    const vectorFile = JSON.parse(await readFile(new URL(
  "../../../../scripts/longmemeval-replay/question-id-digest-vectors.json",
      import.meta.url
    ), "utf8")) as {
      invalid_canonical_preimages: Array<{
        name: string;
        question_id_sequences: string[][];
      }>;
      vectors: Array<{
        name: string;
        question_ids: string[];
        canonical_nul_v1: string;
        legacy_snapshot_length_prefix_v1: string;
      }>;
    };
    const vector = vectorFile.vectors.find((row) => row.name === "ordered_unicode_pair")!;
    const rows = vector.question_ids.map((id, index) =>
      cohortRow({ id, goldIds: [`gold-${index}`] })
    );
    const raw = contract(rows.map((row, index) =>
      question(row.question_id, [], row)
    ), rows);
    expect(() => validateEvidenceBundle({
      ...raw,
      cohort: { ...raw.cohort, question_id_digest: vector.canonical_nul_v1 }
    })).not.toThrow();
    expect(() => validateEvidenceBundle({
      ...raw,
      cohort: { ...raw.cohort, question_id_digest: vector.legacy_snapshot_length_prefix_v1 }
    })).toThrow(/question_id_digest mismatch/u);

    const collision = vectorFile.invalid_canonical_preimages.find(
      (row) => row.name === "nul_delimiter_collision"
    )!;
    expect(collision.question_id_sequences).toHaveLength(2);
    const [left, right] = collision.question_id_sequences;
    expect(left!.join("\0")).toBe(right!.join("\0"));
    for (const questionIds of collision.question_id_sequences) {
      const invalidRows = questionIds.map((id, index) =>
        cohortRow({ id, goldIds: [`gold-invalid-${index}`] })
      );
      const invalid = contract(invalidRows.map((row, index) =>
        question(row.question_id, [], row)
      ), invalidRows);
      expect(() => validateEvidenceBundle(invalid)).toThrow(/NUL-free/u);
    }
  });

  it("runs as a thin manifest CLI and exposes help without loading evidence", async () => {
    const help = await execFileAsync("node", [cliPath, "--help"]);
    expect(help.stdout).toContain("--manifest <file>");

    const row = cohortRow({ id: "q-cli", goldIds: ["gold-a"], retrieval: "hit_at_5" });
    const ranks = {
      fused_rank: 1, rank_after_fusion: 1, feature: 1, lexical: 1,
      coverage: 1, session: 1, synthesis: 1, structural: 1,
      selection_order: 1, final_rank: 1
    };
    const bundle = await writeBundle(contract([
      question("q-cli", [candidate("gold-a", ranks)], row)
    ], [row]));
    const result = await execFileAsync("node", [cliPath, "--manifest", bundle.manifestPath]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "longmemeval_stage_matrix",
      summary: { dataset_answerable: 1, scorable_answerable: 1 }
    });
  });
});
