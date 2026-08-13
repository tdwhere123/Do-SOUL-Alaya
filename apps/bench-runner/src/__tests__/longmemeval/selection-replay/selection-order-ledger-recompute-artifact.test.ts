import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
  FAMILY_GROUPED_COMPOSITION_OPERATOR_ID
} from "@do-soul/alaya-core";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../../../../../packages/core/src/recall/delivery/selection-boundary/selection-boundary-types.js";
import { captureFineAssessmentSelectionBoundary } from
  "../../../../../../packages/core/src/__tests__/recall/selection-boundary-live-capture-fixture.js";

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
  materializeSelectionOrderLedgerArtifact,
  resolveLedgerFidelity
} from "../../../longmemeval/selection-replay/selection-order-ledger-artifact.js";

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

  it("recomputes live membership and family receipts under recompute_live", async () => {
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
      family_scores: Record<string, {
        lexical_evidence: number;
        semantic: number | null;
        fusion: number | null;
      }>;
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
      FAMILY_GROUPED_COMPOSITION_OPERATOR_ID
    );
    expect(question.live_delivered_keys.length).toBeGreaterThan(0);
    expect(question.captured_delivered_keys).toEqual(original.expected.candidate_keys);
    expect(Object.values(question.family_scores).every((family) =>
      typeof family.lexical_evidence === "number" &&
      (family.semantic === null || typeof family.semantic === "number") &&
      (family.fusion === null || typeof family.fusion === "number")
    )).toBe(true);
    expect(Object.values(question.family_scores).some((family) =>
      family.semantic !== null
    )).toBe(true);
    expect(summary.formula_operator_id).toBe(FAMILY_GROUPED_COMPOSITION_OPERATOR_ID);
    expect(summary.any_at_1).toBeGreaterThanOrEqual(0);
    expect(summary.any_at_5 + summary.any_at_10).toBeGreaterThanOrEqual(0);
    expect(summary.coverage_at_5).toBeGreaterThanOrEqual(0);
    expect(summary.feasibility_protection_deltas.final_budget).toMatchObject({
      gained: expect.any(Number),
      lost: expect.any(Number)
    });
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

function objectIdFromKey(candidateKey: string): string {
  return candidateKey.split(":").at(-1)!;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selection-order-ledger-recompute-"));
  roots.push(root);
  return root;
}
