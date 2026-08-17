import { FIELD_PINS } from "../../../../../../packages/core/src/__tests__/recall/fine-assessment-selection-fixtures.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertFineAssessmentOrderLedgerAttribution
} from
  "@do-soul/alaya-core";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import { fineAssess } from
  "../../../../../../packages/core/src/recall/delivery/fine-assessment.js";
import { buildDefaultPolicy } from
  "../../../../../../packages/core/src/recall/runtime/orchestration.js";
import { materializeFineAssessmentSelectionBoundary } from
  "../../../../../../packages/core/src/recall/delivery/selection-boundary/selection-boundary-capture.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../../../../../packages/core/src/recall/delivery/selection-boundary/selection-boundary-types.js";
import {
  createRankedCandidate,
  createSupplementaryData
} from "../../../../../../packages/core/src/__tests__/recall/fine-assessment-selection-fixtures.js";
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

import { materializeSelectionOrderLedgerArtifact as materializeRawLedger } from
  "../../../longmemeval/selection-replay/order-ledger/artifact.js";

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

describe("selection order ledger artifact", () => {
  it("binds the source and publishes one immutable canonical ledger", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "selection-boundaries.ndjson.gz");
    const outputPath = join(root, "selection-order-ledger.ndjson.gz");
    const boundary = captureFineAssessmentSelectionBoundary("ledger-artifact");
    const source = gzipSync(`${JSON.stringify({
      question_id: "question-1",
      invocation_index: 0,
      authoritative: true,
      boundary
    })}\n`);
    await writeFile(sourcePath, source, { flag: "wx" });
    const sourceSha256 = createHash("sha256").update(source).digest("hex");

    const identity = await materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    });
    const rows = gunzipSync(await readFile(outputPath)).toString("utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(identity).toMatchObject({
      source_sha256: sourceSha256,
      source_commit: "a".repeat(40),
      question_count: 1,
      coarse_unavailable_questions: 0
    });
    expect(rows.map((row) => row.record_type)).toEqual([
      "manifest", "question", "summary"
    ]);
    expect(rows[0]).toMatchObject({
      source_artifact_sha256: sourceSha256,
      source_commit: "a".repeat(40)
    });
    expect(rows[2]).toMatchObject({
      question_count: 1,
      coarse_unavailable_questions: 0
    });
    const duplicatePublication = materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    }).then(() => null, (error: unknown) => error);
    await expect(duplicatePublication).resolves.toBeDefined();
  });

  it("rejects a source digest mismatch before publication", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "selection-boundaries.ndjson.gz");
    const source = gzipSync(`${JSON.stringify({
      question_id: "question-1",
      invocation_index: 0,
      authoritative: true,
      boundary: captureFineAssessmentSelectionBoundary("digest-mismatch")
    })}\n`);
    await writeFile(sourcePath, source, { flag: "wx" });

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: "0".repeat(64),
      outputPath: join(root, "ledger.ndjson.gz"),
      checkoutRoot: root
    })).rejects.toThrow(/source SHA-256 mismatch/u);
  });

  it("rejects a mismatched authoritative question population", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "population-source.ndjson.gz");
    const outputPath = join(root, "population-ledger.ndjson.gz");
    const source = gzipSync(`${JSON.stringify({
      question_id: "population-question",
      invocation_index: 0,
      authoritative: true,
      boundary: captureFineAssessmentSelectionBoundary("population-mismatch")
    })}\n`);
    await writeFile(sourcePath, source, { flag: "wx" });
    const sourceSha256 = createHash("sha256").update(source).digest("hex");

    await expect(materializeRawLedger({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      expectedQuestionCount: 2,
      expectedQuestionIdDigest: computeLongMemEvalQuestionIdDigest([
        "population-question", "missing-question"
      ]),
      outputPath,
      checkoutRoot: root,
      computeExecutedDistIdentity: async () => ({
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "c".repeat(64),
        file_count: 1
      })
    })).rejects.toThrow(/source population identity mismatch/u);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a legacy source without coarse identity before publication", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "legacy-selection-boundaries.ndjson.gz");
    const outputPath = join(root, "legacy-ledger.ndjson.gz");
    const captured = captureFineAssessmentSelectionBoundary("legacy-ledger");
    const boundary = {
      ...captured,
      input: { ...captured.input, packet_candidate_keys: undefined }
    };
    const source = gzipSync(`${JSON.stringify({
      question_id: "legacy-question",
      invocation_index: 0,
      authoritative: true,
      boundary
    })}\n`);
    await writeFile(sourcePath, source, { flag: "wx" });
    const sourceSha256 = createHash("sha256").update(source).digest("hex");

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    })).rejects.toThrow(
      /selection order ledger record verification failed \(question_id=legacy-question, invocation_index=0, record_index=0\): .*coarse identity is unavailable/u
    );
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the first reconstruction mismatch record before publication", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "mismatch-selection-boundaries.ndjson.gz");
    const outputPath = join(root, "mismatch-ledger.ndjson.gz");
    const captured = captureFineAssessmentSelectionBoundary("mismatch-ledger");
    const boundary = {
      ...captured,
      input: { ...captured.input, token_estimates_by_content: [] }
    };
    const source = gzipSync([
      JSON.stringify({
        question_id: "healthy-question",
        invocation_index: 0,
        authoritative: true,
        boundary: captureFineAssessmentSelectionBoundary("mismatch-ledger")
      }),
      JSON.stringify({
        question_id: "mismatch-question",
        invocation_index: 0,
        authoritative: true,
        boundary
      }),
      ""
    ].join("\n"));
    await writeFile(sourcePath, source, { flag: "wx" });
    const sourceSha256 = createHash("sha256").update(source).digest("hex");

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    })).rejects.toThrow(
      /selection replay record verification failed \(question_id=mismatch-question, invocation_index=0, record_index=1\): selection boundary fidelity mismatch: captured token estimate missing: expected token_estimates_by_content entry for content sha256:[0-9a-f]{64} \(chars=\d+\), actual absent among 0 captured contents/u
    );
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes one Gamma membership owner per changed candidate", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "sequential-selection-boundaries.ndjson.gz");
    const outputPath = join(root, "sequential-ledger.ndjson.gz");
    const boundary = captureSequentialMembershipBoundary();
    const source = gzipSync(`${JSON.stringify({
      question_id: "sequential-question",
      invocation_index: 0,
      authoritative: true,
      boundary
    })}\n`);
    await writeFile(sourcePath, source, { flag: "wx" });
    const sourceSha256 = createHash("sha256").update(source).digest("hex");

    const identity = await materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    });
    const rows = gunzipSync(await readFile(outputPath)).toString("utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as {
        record_type: string;
        ledger?: {
          candidates: readonly Readonly<{
            first_membership_changing_owner: string | null;
            membership_changing_owners: readonly string[];
          }>[];
        };
      });
    const candidates = rows[1]?.ledger?.candidates ?? [];
    const changed = candidates.filter(
      (candidate) => candidate.membership_changing_owners.length > 0
    );

    expect(identity.question_count).toBe(1);
    expect(
      changed.length,
      JSON.stringify(candidates.map((candidate) => ({
        first: candidate.first_membership_changing_owner,
        owners: candidate.membership_changing_owners
      })))
    ).toBeGreaterThan(0);
    expect(changed.every((candidate) =>
      candidate.first_membership_changing_owner === "select_gamma" &&
        candidate.membership_changing_owners.length === 1 &&
        candidate.membership_changing_owners[0] === "select_gamma"
    )).toBe(true);
  });

  it("still refuses duplicate Gamma membership ownership", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution({
      schema_version: 2,
      candidate_count: 1,
      delivered_count: 1,
      coarse_identity: "captured",
      candidates: [{
        candidate_key: "tied-candidate",
        ranks: {
          coarse: 1,
          fusion: 2,
          deep_head: 1,
          select_gamma: 1,
          final: 1
        },
        first_membership_changing_owner: "select_gamma",
        membership_changing_owners: ["select_gamma", "select_gamma"]
      }]
    })).toThrow(
      /selection order ledger has multiple simultaneous membership-changing owners/u
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selection-order-ledger-test-"));
  roots.push(root);
  return root;
}

function captureSequentialMembershipBoundary(): FineAssessmentSelectionBoundaryCase {
  const candidates = Object.freeze(Array.from({ length: 6 }, (_, index) =>
    createRankedCandidate(`seq-${index + 1}`, index + 1, 1 - index * 0.05)
  ));
  const policy = buildDefaultPolicy({
    strategy: "chat",
    taskSurfaceRef: "ledger-sequential",
    now: () => "2026-07-29T00:00:00.000Z",
    generateRuntimeId: () => "11111111-1111-4111-8111-111111111111"
  });
  let captured: FineAssessmentSelectionBoundaryCase | undefined;
  fineAssess({
    ...FIELD_PINS,
    candidates,
    policy: {
      ...policy,
      fine_assessment: {
        ...policy.fine_assessment,
        budgets: { ...policy.fine_assessment.budgets, max_entries: 2 }
      }
    },
    winnerMemoryIds: new Set(),
    supplementaryData: createSupplementaryData({
      ftsRanks: Object.fromEntries(candidates.map((candidate, index) => [
        candidate.entry.object_id,
        0.1 + index * 0.15
      ])),
      trigramFtsRanks: Object.fromEntries(candidates.map((candidate, index) => [
        candidate.entry.object_id,
        0.1 + index * 0.12
      ])),
      evidenceGistsByMemoryId: Object.fromEntries(candidates.map((candidate, index) => [
        candidate.entry.object_id,
        index < 2 ? "shared gist" : `novel-${index}`
      ])),
      embeddingSimilarityScores: Object.fromEntries(candidates.map((candidate, index) => [
        candidate.entry.object_id,
        index < 2 ? 0.95 - index * 0.05 : 0.1
      ]))
    }),
    tokenEstimator: { estimate: () => 5 },
    now: () => "2026-07-29T00:00:00.000Z",
    warn: vi.fn(),
    captureAnswerFeatures: true,
    capturePacketPlanTrace: true,
    selectionBoundaryObserver: (pending) => {
      captured = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }
  });
  if (captured === undefined) throw new Error("sequential boundary is missing");
  return captured;
}
