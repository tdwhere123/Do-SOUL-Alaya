import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The executable MJS analyzer is intentionally outside the package declaration surface.
import { consumeReplayContract, loadReplayContract, validateReplayContract } from "../../../../scripts/longmemeval-replay/contract.mjs";
// @ts-expect-error The executable MJS analyzer is intentionally outside the package declaration surface.
import { buildStageMatrix } from "../../../../scripts/longmemeval-replay/stage-matrix.mjs";
import {
  candidate,
  cohortRow,
  contract,
  qualityAxes,
  question,
  writeBundle
} from "./stage-matrix-fixture.js";

describe("LongMemEval stage matrix replay", () => {
  it("loads gzip diagnostics after binding their raw bytes", async () => {
    const row = cohortRow({ id: "q-gzip", goldIds: ["gold-a"] });
    const bundle = await writeBundle(contract([
      question("q-gzip", [candidate("gold-a", { fused_rank: 1 })], row)
    ], [row]), true, true);

    await expect(loadReplayContract(bundle.manifestPath)).resolves.toMatchObject({
      diagnostics: { questions: [{ question_id: "q-gzip" }] }
    });

    const artifactPath = path.join(bundle.root, "full.json.gz");
    const bytes = await readFile(artifactPath);
    bytes[10] = (bytes[10] ?? 0) ^ 0xff;
    await writeFile(artifactPath, bytes);
    await expect(loadReplayContract(bundle.manifestPath)).rejects.toThrow(
      /sha256 mismatch.*full\.json\.gz/u
    );
  });

  it("consumes complete replay questions without retaining full diagnostics", async () => {
    const row = cohortRow({ id: "q-stream", goldIds: ["gold-a"] });
    const bundle = await writeBundle(contract([
      question("q-stream", [candidate("gold-a", {
        fused_rank: 1, rank_after_fusion: 1, feature: 1, lexical: 1,
        coverage: 1, session: 1, synthesis: 1, structural: 1,
        selection_order: 1, final_rank: 1
      })], row)
    ], [row]));
    const seen: string[] = [];

    const loaded = await consumeReplayContract(bundle.manifestPath, {
      onQuestion: (diagnostic: { question_id: string }) => seen.push(diagnostic.question_id)
    });

    expect(seen).toEqual(["q-stream"]);
    expect(loaded.diagnostics.questions).toEqual([]);
  });
  it("rejects hash drift and incomplete candidate pools", async () => {
    const row = cohortRow({ id: "q1", goldIds: ["gold-a"] });
    const bundle = await writeBundle(contract([
      question("q1", [candidate("gold-a", { fused_rank: 1 })], row)
    ], [row]));
    const original = await readFile(path.join(bundle.root, "full.json"), "utf8");
    await writeFile(
      path.join(bundle.root, "full.json"),
      original.replace('"schema_version": 1', '"schema_version": 2')
    );
    await expect(loadReplayContract(bundle.manifestPath)).rejects.toThrow(/sha256 mismatch.*full\.json/u);

    const incomplete = contract([
      { ...question("q1", [candidate("gold-a", { fused_rank: 1 })], row), candidate_pool_complete: false }
    ], [row]);
    expect(() => validateReplayContract(incomplete)).toThrow(/candidate_pool_complete=true.*q1/u);
  });

  it("requires explicit stage ranks and never accepts rank aliases", () => {
    const row = cohortRow({ id: "q-alias", goldIds: ["gold-a"] });
    const aliased = {
      object_id: "gold-a",
      object_kind: "memory_entry",
      origin_plane: "workspace_local",
      candidate_key: "workspace_local:memory_entry:gold-a",
      pre_budget_rank: 1,
      relevance_score: 0.99,
      rank: 1,
      fused_score: 0.4,
      score_factors: { facet_overlap: 2 }
    };
    expect(() => validateReplayContract(contract([
      question("q-alias", [aliased], row)
    ], [row]))).toThrow(/missing required rank field.*fused_rank/u);
  });

  it("binds replay closure to exact origin-plane candidate keys", () => {
    const row = cohortRow({ id: "q-origin-plane", goldIds: ["gold-a"] });
    const local = candidate("gold-a", { fused_rank: 1 });
    const global = {
      ...candidate("gold-a", { fused_rank: 2 }),
      origin_plane: "global",
      candidate_key: "global:memory_entry:gold-a"
    };
    const aliases = {
      ...question("q-origin-plane", [local, global], row),
      candidate_pool_count: 2
    };
    expect(() => validateReplayContract(contract([aliases], [row]))).not.toThrow();

    const forged = {
      ...question("q-origin-plane", [{
        ...local,
        candidate_key: "global:memory_entry:gold-a"
      }], row),
      candidate_pool_count: 1
    };
    expect(() => validateReplayContract(contract([forged], [row])))
      .toThrow(/candidate identity key/u);
  });

  it("uses the explicit stage order and computes K ceilings for any gold", () => {
    const row = cohortRow({ id: "q-multi", goldIds: ["gold-a", "gold-b"], retrieval: "hit_at_5" });
    const candidates = [
      candidate("gold-a", {
        fused_rank: 60, rank_after_fusion: 40, feature: 20, lexical: 10,
        coverage: 6, session: 5, synthesis: 4, structural: 3,
        selection_order: 2, final_rank: 2
      }),
      candidate("gold-b", {
        fused_rank: 100, rank_after_fusion: 80, feature: 50, lexical: 25,
        coverage: 10, session: 8, synthesis: 7, structural: 6,
        selection_order: 5, final_rank: 5
      }),
      candidate("rank-five", {
        fused_rank: 5, rank_after_fusion: 5, feature: 5, lexical: 5,
        coverage: 5, session: 4, synthesis: 5, structural: 5,
        selection_order: 4, final_rank: 4
      })
    ];
    const matrix = buildStageMatrix(contract([question("q-multi", candidates, row)], [row]));
    expect(matrix.stage_order).toEqual([
      "candidate_pool", "rank_after_fusion", "feature", "lexical", "coverage",
      "session", "synthesis", "structural", "selection_order", "final_rank"
    ]);
    expect(matrix.stage_rank_fields).toMatchObject({
      candidate_pool: "fused_rank",
      synthesis: "rank_after_synthesis_reserve",
      final_rank: "final_rank"
    });
    expect(matrix.questions[0].any_gold_at_k.candidate_pool).toEqual({
      "5": false, "10": false, "25": false, "50": false, "100": true
    });
    expect(matrix.questions[0].any_gold_at_k.session["5"]).toBe(true);
    expect(matrix.summary.by_stage.final_rank.at_5).toMatchObject({ count: 1, denominator: 1, rate: 1 });
    expect(matrix.summary.quality_axes).toMatchObject({
      answerable: {
        measured_question_count: 0,
        answer_session_coverage_at_5: { full_coverage_rate: null, ratio: null },
        answer_literal_witness_lower_bound_at_5: { rate: null },
        source_timestamp_availability_at_5: { ratio: null }
      },
      abstention: { measured_question_count: 0, correct_rate: null }
    });
  });

  it("keeps answerable measurement axes and abstention outcomes in separate summaries", () => {
    const answerableAxes = qualityAxes({ coverage: [1, 2], timestamps: [2, 5] });
    const abstentionAxes = qualityAxes({
      coverage: [0, 0],
      literalWitnessed: false,
      timestamps: [1, 3],
      abstention: "uncalibrated"
    });
    const answerable = cohortRow({
      id: "q-answerable",
      goldIds: ["gold-a"],
      retrieval: "hit_at_5",
      qualityAxes: answerableAxes
    });
    const abstention = cohortRow({
      id: "q-abstention",
      goldIds: [],
      datasetCohort: "abstention",
      status: "absent",
      qualityAxes: abstentionAxes
    });
    const matrix = buildStageMatrix(contract([
      question("q-answerable", [candidate("gold-a", {
        fused_rank: 1, rank_after_fusion: 1, feature: 1, lexical: 1,
        coverage: 1, session: 1, synthesis: 1, structural: 1,
        selection_order: 1, final_rank: 1
      })], answerable),
      question("q-abstention", [], abstention)
    ], [answerable, abstention]));

    expect(matrix.questions[0].quality_axes).toEqual(answerableAxes);
    expect(matrix.summary.quality_axes.answerable).toMatchObject({
      measured_question_count: 1,
      answer_session_coverage_at_5: {
        full_coverage_count: 0,
        covered_count: 1,
        total_count: 2,
        ratio: 0.5
      },
      answer_literal_witness_lower_bound_at_5: {
        witnessed_count: 1,
        rate: 1
      },
      source_timestamp_availability_at_5: {
        available_count: 2,
        candidate_count: 5,
        ratio: 0.4
      }
    });
    expect(matrix.summary.quality_axes.abstention).toEqual({
      measured_question_count: 1,
      scored_count: 0,
      uncalibrated_count: 1,
      correct_count: 0,
      false_confident_count: 0,
      correct_rate: null
    });
  });
});
