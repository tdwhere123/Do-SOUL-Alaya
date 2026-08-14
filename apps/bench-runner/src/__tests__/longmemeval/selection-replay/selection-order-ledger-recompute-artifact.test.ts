import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
  SELECTION_COMPOSITION_FIDELITY_MISMATCH,
  counterfactualDeliveredCandidateKeys,
  reconstructFineAssessmentComposition
} from "@do-soul/alaya-core";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../../../../../packages/core/src/recall/delivery/selection-boundary/selection-boundary-types.js";
import {
  captureFineAssessmentSelectionBoundary,
  withCapturedOrderAlignedExpected,
  withDivergentCandidatePopulation
} from
  "../../../../../../packages/core/src/__tests__/recall/selection-boundary-live-capture-fixture.js";
import {
  deltaTotal,
  objectIdFromKey,
  symmetricDifferenceSize
} from "./order-ledger/assertions.js";

const { measureGitState } = vi.hoisted(() => ({
  measureGitState: vi.fn(async () => ({
    commitSha: "a".repeat(40),
    commitSha7: "a".repeat(7),
    worktreeStateSha256: "b".repeat(64),
    worktreeClean: true
  }))
}));

vi.mock(
  "../../../longmemeval/provenance/contract/frozen-code-contract.js",
  () => ({ measureGitState })
);

import {
  materializeSelectionOrderLedgerArtifact as materializeRawLedger,
  resolveLedgerFidelity
} from "../../../longmemeval/selection-replay/order-ledger/artifact.js";

async function materializeSelectionOrderLedgerArtifact(
  input: Omit<Parameters<typeof materializeRawLedger>[0],
    "expectedQuestionCount" | "expectedQuestionIdDigest">
) {
  const records = gunzipSync(await readFile(input.sourcePath)).toString("utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      question_id: string; authoritative: boolean;
    });
  const ids = records.filter((row) => row.authoritative)
    .map((row) => row.question_id);
  return materializeRawLedger({
    ...input,
    expectedQuestionCount: ids.length,
    expectedQuestionIdDigest: computeLongMemEvalQuestionIdDigest(ids),
    computeExecutedDistIdentity: async () => ({
      algorithm: "sha256-reachable-path-file-sha256-v1",
      sha256: "c".repeat(64),
      file_count: 1
    })
  });
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

describe("selection order ledger recompute_live", () => {
  it("keeps default materialize on captured-score fidelity", async () => {
    const { identity, outputPath } = await publishLiveLedger("assert-default");

    expect(identity.captured_score_fidelity).toBe("assert");
    expect(identity.recompute).toBeUndefined();
    const manifest = await readLedgerRows(outputPath);
    expect(manifest[0]).toMatchObject({
      schema_version: 1
    });
    expect(manifest[0]).not.toHaveProperty("captured_score_fidelity");
  });

  it("refuses a gold map on the default fidelity path", () => {
    expect(() => resolveLedgerFidelity({
      goldMapPath: "/tmp/gold.json"
    })).toThrow(/gold map applies only to captured-score-fidelity recompute-live/u);
  });

  it("refuses recompute_live without a gold map", () => {
    expect(() => resolveLedgerFidelity({
      capturedScoreFidelity: CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE
    })).toThrow(/recompute_live requires a gold map/u);
  });

  it("still asserts captured scores on the default path", async () => {
    const root = await temporaryRoot();
    const boundary = withInjectedEmbeddings(
      captureFineAssessmentSelectionBoundary("recompute-default-drift")
    );
    const { sourcePath, sourceSha256, outputPath } = await writeBoundaryGzip(
      root,
      "drift-question",
      boundary
    );

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    })).rejects.toThrow(/selection composition fidelity mismatch/u);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recomputes live membership under recompute_live", async () => {
    const root = await temporaryRoot();
    const original = captureFineAssessmentSelectionBoundary("recompute-live");
    const boundary = withInjectedEmbeddings(original);
    const { sourcePath, sourceSha256, outputPath } = await writeBoundaryGzip(
      root,
      "question-1",
      boundary
    );
    const goldObjectId = objectIdFromKey(original.expected.candidate_keys[0]!);
    const goldMapPath = await writeGoldMap(root, "question-1", goldObjectId);

    const identity = await materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root,
      capturedScoreFidelity: CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
      goldMapPath
    });
    const rows = await readLedgerRows(outputPath);
    const question = rows[1] as {
      live_delivered_keys: readonly string[];
      captured_delivered_keys: readonly string[];
      gold: { any_at_5: boolean };
    };
    const summary = rows[2] as {
      formula_operator_id: string;
      any_at_1: number;
      any_at_5: number;
      any_at_10: number;
      full_gold_at_5: number;
      coverage_at_5: number;
      feasibility_protection_deltas: Record<string, {
        gained: number;
        lost: number;
      }>;
    };

    expect(identity.captured_score_fidelity).toBe("recompute_live");
    expect(identity.recompute?.formula_operator_id).toBe(
      "lightweight_deep_head_prob_or_v1"
    );
    expect(question.live_delivered_keys.length).toBeGreaterThan(0);
    expect(question.captured_delivered_keys).toEqual(original.expected.candidate_keys);
    expect(summary.formula_operator_id).toBe("lightweight_deep_head_prob_or_v1");
    expect(summary.any_at_1).toBe(1);
    expect(summary.any_at_5).toBe(1);
    expect(summary.any_at_10).toBe(1);
    expect(question.gold.any_at_5).toBe(true);
    expect(summary.coverage_at_5).toBe(1);
    expect(summary.feasibility_protection_deltas.final_budget).toMatchObject({
      gained: expect.any(Number),
      lost: expect.any(Number)
    });
  });

  it("publishes when live membership diverges and Any@5 follows the live head", async () => {
    const published = await publishDivergentRecompute((liveKeys) =>
      objectIdFromKey(liveKeys[0]!)
    );
    const question = published.question;
    const summary = published.summary;

    expect(question.live_delivered_keys).not.toEqual(question.captured_delivered_keys);
    expect(question.gold.any_at_5).toBe(true);
    expect(summary.any_at_5).toBe(1);
    expect(summary.any_at_1).toBe(1);
    expect(deltaTotal(summary.feasibility_protection_deltas)).toBe(
      symmetricDifferenceSize(
        question.captured_delivered_keys,
        question.live_delivered_keys
      )
    );
    expect(summary.feasibility_protection_deltas.unavailable).toEqual({
      gained: 0,
      lost: 0
    });
  });

  it("counts Any@5 as 0 when gold is outside the live head", async () => {
    const published = await publishDivergentRecompute(() => "absent-gold-object");
    expect(published.question.live_delivered_keys)
      .not.toEqual(published.question.captured_delivered_keys);
    expect(published.question.gold.any_at_5).toBe(false);
    expect(published.summary.any_at_1).toBe(0);
    expect(published.summary.any_at_5).toBe(0);
    expect(published.summary.any_at_10).toBe(0);
  });

  it("fails closed on a missing gold map QID without publishing", async () => {
    const root = await temporaryRoot();
    const { sourcePath, sourceSha256, outputPath } = await writeBoundaryGzip(
      root,
      "question-1",
      captureFineAssessmentSelectionBoundary("recompute-missing-gold")
    );
    const goldMapPath = await writeGoldMap(root, "other-question", "gold-1");

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root,
      capturedScoreFidelity: CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
      goldMapPath
    })).rejects.toThrow(/missing gold map entry for question-1/u);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on fused-score drift in recompute_live without publishing", async () => {
    const root = await temporaryRoot();
    const captured = captureFineAssessmentSelectionBoundary("recompute-fused");
    const relevance = captured.input.final_relevance_by_candidate_key;
    if (relevance === undefined || relevance.length === 0) {
      throw new Error("final relevance was not captured");
    }
    const [first, ...rest] = relevance;
    const boundary = withCapturedOrderAlignedExpected({
      ...captured,
      input: {
        ...captured.input,
        final_relevance_by_candidate_key: [
          [first![0], first![1] + 0.01],
          ...rest
        ]
      }
    });
    const { sourcePath, sourceSha256, outputPath } = await writeBoundaryGzip(
      root,
      "fused-question",
      boundary
    );
    const goldMapPath = await writeGoldMap(
      root,
      "fused-question",
      objectIdFromKey(captured.expected.candidate_keys[0]!)
    );

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root,
      capturedScoreFidelity: CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
      goldMapPath
    })).rejects.toThrow(`${SELECTION_COMPOSITION_FIDELITY_MISMATCH}: final_relevance`);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on candidate population drift in recompute_live without publishing", async () => {
    const root = await temporaryRoot();
    const captured = captureFineAssessmentSelectionBoundary("recompute-population");
    const boundary = withCapturedOrderAlignedExpected(
      withDivergentCandidatePopulation(captured)
    );
    const { sourcePath, sourceSha256, outputPath } = await writeBoundaryGzip(
      root,
      "population-question",
      boundary
    );
    const goldMapPath = await writeGoldMap(
      root,
      "population-question",
      objectIdFromKey(captured.expected.candidate_keys[0]!)
    );

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root,
      capturedScoreFidelity: CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
      goldMapPath
    })).rejects.toThrow(`${SELECTION_COMPOSITION_FIDELITY_MISMATCH}: candidate_population`);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not swallow a hydrate failure in recompute_live", async () => {
    const root = await temporaryRoot();
    const captured = captureFineAssessmentSelectionBoundary("recompute-hydrate");
    const boundary = {
      ...captured,
      input: { ...captured.input, token_estimates_by_content: [] }
    };
    const { sourcePath, sourceSha256, outputPath } = await writeBoundaryGzip(
      root,
      "hydrate-question",
      boundary
    );
    const goldMapPath = await writeGoldMap(
      root,
      "hydrate-question",
      objectIdFromKey(captured.expected.candidate_keys[0]!)
    );

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root,
      capturedScoreFidelity: CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
      goldMapPath
    })).rejects.toThrow(/captured token estimate missing/u);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function publishLiveLedger(label: string) {
  const root = await temporaryRoot();
  const { sourcePath, sourceSha256, outputPath } = await writeBoundaryGzip(
    root,
    "question-1",
    captureFineAssessmentSelectionBoundary(label)
  );
  const identity = await materializeSelectionOrderLedgerArtifact({
    sourcePath,
    expectedSourceSha256: sourceSha256,
    outputPath,
    checkoutRoot: root
  });
  return { identity, outputPath };
}

async function writeBoundaryGzip(
  root: string,
  questionId: string,
  boundary: FineAssessmentSelectionBoundaryCase
) {
  const sourcePath = join(root, `${questionId}-selection-boundaries.ndjson.gz`);
  const outputPath = join(root, `${questionId}-ledger.ndjson.gz`);
  const source = gzipSync(`${JSON.stringify({
    question_id: questionId,
    invocation_index: 0,
    authoritative: true,
    boundary
  })}\n`);
  await writeFile(sourcePath, source, { flag: "wx" });
  return {
    sourcePath,
    outputPath,
    sourceSha256: createHash("sha256").update(source).digest("hex")
  };
}

async function writeGoldMap(
  root: string,
  questionId: string,
  goldObjectId: string
): Promise<string> {
  const goldMapPath = join(root, "gold.json");
  await writeFile(goldMapPath, `${JSON.stringify({
    questions: [{
      question_id: questionId,
      is_abstention: false,
      premise_invalid: false,
      gold_object_ids: [goldObjectId]
    }]
  })}\n`, { flag: "wx" });
  return goldMapPath;
}

async function readLedgerRows(outputPath: string) {
  return gunzipSync(await readFile(outputPath)).toString("utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function withInjectedEmbeddings(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  const embeddingSimilarityScores = Object.fromEntries(
    boundary.input.ordered_candidates.map((candidate, index) => [
      candidate.entry.object_id,
      0.95 - index * 0.05
    ])
  );
  return {
    ...boundary,
    input: {
      ...boundary.input,
      supplementary_data: {
        ...boundary.input.supplementary_data,
        embeddingSimilarityScores
      }
    }
  };
}

function withTailDominantEmbeddings(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  const count = Math.max(1, boundary.input.ordered_candidates.length - 1);
  const embeddingSimilarityScores = Object.fromEntries(
    boundary.input.ordered_candidates.map((candidate, index) => [
      candidate.entry.object_id,
      0.05 + (index / count) * 0.9
    ])
  );
  return {
    ...boundary,
    input: {
      ...boundary.input,
      supplementary_data: {
        ...boundary.input.supplementary_data,
        embeddingSimilarityScores
      }
    }
  };
}

async function publishDivergentRecompute(
  goldObjectId: (liveKeys: readonly string[]) => string
) {
  const root = await temporaryRoot();
  const original = captureFineAssessmentSelectionBoundary(
    "recompute-divergent",
    {},
    { maxEntries: 2 }
  );
  const boundary = withTailDominantEmbeddings(original);
  const live = reconstructFineAssessmentComposition(boundary, {
    capturedScoreFidelity: CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE
  });
  const liveKeys = counterfactualDeliveredCandidateKeys(live.result);
  const capturedKeys = original.expected.candidate_keys;
  if (liveKeys.length === capturedKeys.length &&
      liveKeys.every((key, index) => key === capturedKeys[index])) {
    throw new Error("expected live delivered keys to diverge from captured");
  }
  const { sourcePath, sourceSha256, outputPath } = await writeBoundaryGzip(
    root,
    "question-1",
    boundary
  );
  const goldMapPath = await writeGoldMap(
    root,
    "question-1",
    goldObjectId(liveKeys)
  );
  await materializeSelectionOrderLedgerArtifact({
    sourcePath,
    expectedSourceSha256: sourceSha256,
    outputPath,
    checkoutRoot: root,
    capturedScoreFidelity: CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
    goldMapPath
  });
  const rows = await readLedgerRows(outputPath);
  return {
    question: rows[1] as {
      live_delivered_keys: readonly string[];
      captured_delivered_keys: readonly string[];
      gold: { any_at_5: boolean };
    },
    summary: rows[2] as {
      any_at_1: number;
      any_at_5: number;
      any_at_10: number;
      feasibility_protection_deltas: Record<string, {
        gained: number;
        lost: number;
      }>;
    }
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selection-order-ledger-recompute-"));
  roots.push(root);
  return root;
}
