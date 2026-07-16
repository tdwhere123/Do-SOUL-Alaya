import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifiedRecallEvalPromotionEntryData,
  verifyRecallEvalPromotionEntry
} from "../../longmemeval/promotion/entry-verifier.js";
import {
  COMMIT_SHA,
  COMMIT_SHA7,
  EXECUTED_DIST,
  GATE_SHA,
  SNAPSHOT_GATE_SHA,
  WORKTREE_SHA
} from "./promotion-entry-primitives-fixture.js";
import {
  cleanupPromotionEntryFixtureRoots,
  duplicateFirstRankQuestion,
  writeEntryFixture
} from "./promotion-entry-fixture.js";

afterEach(cleanupPromotionEntryFixtureRoots);

describe("recall-eval promotion entry verifier", () => {
  it("accepts a producer-written, hash-bound, full-snapshot cache-only entry", async () => {
    const fixture = await writeEntryFixture();

    const entry = await verifyRecallEvalPromotionEntry({
      entryRoot: fixture.entryRoot,
      expectedSelection: fixture.selection,
      treatment: { embedding_supplement: false, answer_rerank: false },
      code: {
        commit_sha: COMMIT_SHA,
        commit_sha7: COMMIT_SHA7,
        worktree_state_sha256: WORKTREE_SHA,
        executed_dist: EXECUTED_DIST
      },
      gateSha256: GATE_SHA,
      snapshot: fixture.snapshot
    });
    const data = verifiedRecallEvalPromotionEntryData(entry);
    const gold = data.snapshot.goldForQuestion("q-1")!;
    const measurement = data.snapshot.measurementForQuestion("q-1")!;
    expect(Object.isFrozen(data.payload.kpi)).toBe(true);
    expect(Object.isFrozen(gold)).toBe(true);
    expect(() => (gold as string[]).push("forged")).toThrow();
    (measurement.sidecar as Map<string, unknown>).clear();
    expect(data.snapshot.measurementForQuestion("q-1")?.sidecar.size).toBe(1);
  });

  it("rejects artifact bytes changed after the manifest was minted", async () => {
    const fixture = await writeEntryFixture();
    await writeFile(path.join(fixture.entryRoot, "report.md"), "forged\n", "utf8");

    await expect(verifyRecallEvalPromotionEntry({
      entryRoot: fixture.entryRoot,
      expectedSelection: fixture.selection,
      treatment: { embedding_supplement: false, answer_rerank: false },
      code: {
        commit_sha: COMMIT_SHA,
        commit_sha7: COMMIT_SHA7,
        worktree_state_sha256: WORKTREE_SHA,
        executed_dist: EXECUTED_DIST
      },
      gateSha256: GATE_SHA,
      snapshot: fixture.snapshot
    })).rejects.toThrow(/mismatch/u);
  });

  it("rejects a snapshot binding that names neither the producer nor matrix gate", async () => {
    const fixture = await writeEntryFixture("5".repeat(64));

    await expect(verifyRecallEvalPromotionEntry({
      entryRoot: fixture.entryRoot,
      expectedSelection: fixture.selection,
      treatment: { embedding_supplement: false, answer_rerank: false },
      code: {
        commit_sha: COMMIT_SHA,
        commit_sha7: COMMIT_SHA7,
        worktree_state_sha256: WORKTREE_SHA,
        executed_dist: EXECUTED_DIST
      },
      gateSha256: GATE_SHA,
      snapshot: fixture.snapshot
    })).rejects.toThrow(/snapshot attribution/u);
  });

  it("rejects evidence executed by a dist closure outside the frozen contract", async () => {
    const fixture = await writeEntryFixture();

    await expect(verifyRecallEvalPromotionEntry({
      entryRoot: fixture.entryRoot,
      expectedSelection: fixture.selection,
      treatment: { embedding_supplement: false, answer_rerank: false },
      code: {
        commit_sha: COMMIT_SHA,
        commit_sha7: COMMIT_SHA7,
        worktree_state_sha256: WORKTREE_SHA,
        executed_dist: { ...EXECUTED_DIST, sha256: "7".repeat(64) }
      },
      gateSha256: GATE_SHA,
      snapshot: fixture.snapshot
    })).rejects.toThrow(/code identity/u);
  });

  it("rejects a snapshot produced by a stale recall pipeline", async () => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, {
      recallPipelineVersion: "stale-pipeline"
    })).rejects.toThrow(/identity.*drifted/u);
  });

  it("rejects a manifest migration that differs from the hashed SQLite bytes", async () => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, {
      schemaMigrationOffset: 1
    })).rejects.toThrow(/identity.*drifted/u);
  });

  it("rejects a promotion snapshot with an explicit gate-ineligible claim", async () => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, {
      storedGateEligible: false
    })).rejects.toThrow(/attribution claim differs/u);
  });

  it("rejects a duplicated rank question before cross-artifact comparison", async () => {
    const fixture = await writeEntryFixture();
    await duplicateFirstRankQuestion(fixture.entryRoot);

    await expect(verifyRecallEvalPromotionEntry({
      entryRoot: fixture.entryRoot,
      expectedSelection: fixture.selection,
      treatment: { embedding_supplement: false, answer_rerank: false },
      code: {
        commit_sha: COMMIT_SHA,
        commit_sha7: COMMIT_SHA7,
        worktree_state_sha256: WORKTREE_SHA,
        executed_dist: EXECUTED_DIST
      },
      gateSha256: GATE_SHA,
      snapshot: fixture.snapshot
    })).rejects.toThrow(/rank identity differs from full snapshot selection/u);
  });

  it.each([
    ["coherence edge accrual", { ALAYA_EXP_COHERENCE_EDGES: "1" }],
    ["bench edge-plane minting", { ALAYA_BENCH_RUN_EDGE_PLANE: "1" }]
  ] as const)("rejects %s in the snapshot producer", async (_label, producerEnvOverride) => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, {
      producerEnvOverride
    })).rejects.toThrow(/seed-time edge formation must be disabled/u);
  });

  it("rejects persisted snapshot provenance with non-product formation", async () => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, {
      producerEnvOverride: { ALAYA_CONFLICT_RULE_ENABLED: "0" }
    })).rejects.toThrow(/product formation/u);
  });

  it("allows inert answers-with tuning for a treatment-neutral producer", async () => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, {
      producerEnvOverride: { ALAYA_EXP_ANSWERS_WITH_CAP: "99" }
    })).resolves.toEqual(expect.objectContaining({
      entryRoot: expect.any(String)
    }));
  });
});
