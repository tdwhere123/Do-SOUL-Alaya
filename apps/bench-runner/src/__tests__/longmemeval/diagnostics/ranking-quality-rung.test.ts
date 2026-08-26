import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  evaluateRecallEvalGzipTailDegeneracy,
  scoreRecallEvalGzipRankingRung
} from "../../../bench/diagnostics.js";
import {
  PLANTED_A_ID,
  PLANTED_B_ID,
  PLANTED_C_ID,
  PLANTED_D_ID,
  PLANTED_E_ID,
  PLANTED_GOLD_ID,
  plantedCandidateKey,
  plantedCanonicalQuestion
} from "./planted-canonical-fixture.js";

const ARTIFACT_RELATIVE =
  ".do-it/bench-runs/recall-any5-evidence-first/g19c-mimo-v2.5-live-prompt-785cbdcc/diagnostic-100q-core-canonical-head-141e739d-eval/history/public/2026-08-26T122305Z-141e739-policy-stress-recall-eval-snapshot/recall-eval-diagnostics.json.gz";

const FIELD_IDS = [
  PLANTED_A_ID,
  PLANTED_B_ID,
  PLANTED_C_ID,
  PLANTED_D_ID,
  PLANTED_E_ID,
  PLANTED_GOLD_ID
] as const;

describe("ranking-quality gzip stream evaluator", () => {
  it("fails tail degeneracy on a planted tied-cohort gzip", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-n4-gzip-fail-"));
    const artifactPath = path.join(root, "recall-eval-diagnostics.json.gz");
    try {
      await writePlantedGzip(artifactPath, tiedQuestions());
      const degeneracy = await evaluateRecallEvalGzipTailDegeneracy(artifactPath);
      expect(degeneracy.holds).toBe(false);
      expect(degeneracy.share).toBe(1);
      const rung = await scoreRecallEvalGzipRankingRung(artifactPath);
      expect(rung.any_at_5.hits).toBe(0);
      expect(rung.tail_share.share).toBe(1);
      expect(rung.cost).toBe("in-process, no snapshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds tail degeneracy on a planted unique-cohort gzip", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-n4-gzip-hold-"));
    const artifactPath = path.join(root, "recall-eval-diagnostics.json.gz");
    try {
      await writePlantedGzip(artifactPath, uniqueQuestions());
      const degeneracy = await evaluateRecallEvalGzipTailDegeneracy(artifactPath);
      expect(degeneracy.holds).toBe(true);
      expect(degeneracy.share).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails tail degeneracy on the 141e739d gzip when present", async () => {
    const artifactPath = resolveGzipArtifact();
    if (artifactPath === null) {
      console.info(`skipping 141e739d gzip degeneracy; missing ${ARTIFACT_RELATIVE}`);
      return;
    }
    const degeneracy = await evaluateRecallEvalGzipTailDegeneracy(artifactPath);
    expect(degeneracy.first_pick_count).toBe(100);
    expect(degeneracy.tail_decided_count).toBe(64);
    expect(degeneracy.share).toBe(0.64);
    expect(degeneracy.holds).toBe(false);
  });
});

function tiedQuestions() {
  const cohort = [
    plantedCandidateKey(PLANTED_A_ID),
    plantedCandidateKey(PLANTED_GOLD_ID)
  ];
  return [0, 1, 2, 3].map((index) => plantedCanonicalQuestion({
    questionId: `n4-tied-${index}`,
    fieldObjectIds: FIELD_IDS,
    deliveredObjectIds: [
      PLANTED_A_ID,
      PLANTED_B_ID,
      PLANTED_C_ID,
      PLANTED_D_ID,
      PLANTED_E_ID
    ],
    firstPickMaxGCohort: cohort
  }));
}

function uniqueQuestions() {
  return [0, 1, 2, 3].map((index) => plantedCanonicalQuestion({
    questionId: `n4-unique-${index}`,
    fieldObjectIds: [PLANTED_GOLD_ID, PLANTED_A_ID],
    deliveredObjectIds: [PLANTED_GOLD_ID]
  }));
}

async function writePlantedGzip(
  artifactPath: string,
  questions: ReturnType<typeof plantedCanonicalQuestion>[]
): Promise<void> {
  await writeFile(artifactPath, gzipSync(Buffer.from(JSON.stringify({
    schema_version: 2,
    kind: "recall_eval_diagnostics",
    questions: questions.map((question) => ({
      question_id: question.question_id,
      diagnostics: question
    }))
  }), "utf8")));
}

function resolveGzipArtifact(): string | null {
  const candidates = [
    path.resolve(process.cwd(), ARTIFACT_RELATIVE),
    path.resolve(process.cwd(), "..", "..", ARTIFACT_RELATIVE)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
