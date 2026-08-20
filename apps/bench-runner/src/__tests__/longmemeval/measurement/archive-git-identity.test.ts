import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBenchArchive } from "../../../bench/archive.js";
import {
  composeArchiveHistorySlug,
  freezeGitStateMeasurement,
  resolveArchiveGitState
} from "../../../bench/provenance/identity/archive-git-identity.js";
import { resolveBenchCheckoutRoot } from "../../../bench/provenance/identity/checkout-root.js";
import type { MeasuredGitState } from "../../../bench/provenance/contract/frozen-code-contract.js";
import { writeMergedLongMemEvalArchive } from "../../../cli/merge/command/merge-command-archive.js";
import {
  buildMergedLongMemEvalPayload,
  loadMergeShards
} from "../../../cli/merge/command/merge-command-shards.js";
import { LongMemEvalDiagnosticsSpool } from "../../../bench/diagnostics/spool.js";
import { setupShard } from "../../cli/merge/cli-merge-evidence-fixture.js";
import { makeShardKpi } from "../../cli/merge/cli-merge-validations-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("archive git identity is measured once", () => {
  it("resolves the repo root from the identity phase folder", () => {
    expect(existsSync(path.join(resolveBenchCheckoutRoot(), "pnpm-workspace.yaml"))).toBe(true);
  });

  it("freezes a mutating measurer so slug and later reads share one state", async () => {
    const measurer = mutatingMeasurer();
    const recorded = await resolveArchiveGitState({ measureGitState: measurer.measure });
    const later = await freezeGitStateMeasurement(recorded)("/unused");
    const slug = composeArchiveHistorySlug({
      runAt: new Date("2026-08-20T05:00:00.000Z"),
      commitSha7: "9e331fa",
      recorded
    });
    expect(measurer.calls).toBe(1);
    expect(later.worktreeStateSha256).toBe(recorded.worktreeStateSha256);
    expect(slug).toContain(`wt-${"aa".repeat(32)}`);
    expect(slug).not.toContain(`wt-${"bb".repeat(32)}`);
  });

  it("refuses a generic archive whose commit label differs from measured HEAD", async () => {
    const historyRoot = await mkdtemp(path.join(tmpdir(), "archive-git-mismatch-"));
    roots.push(historyRoot);
    await expect(writeBenchArchive({
      identity: {
        benchName: "public",
        split: "longmemeval-s",
        diagnosticsFilename: "diagnostics.json"
      },
      historyRoot,
      runAt: new Date("2026-08-20T05:00:00.000Z"),
      commitSha7: "deadbee",
      payload: makeShardKpi({ alaya_commit: "deadbee" }),
      diagnosticsPayload: {
        schema_version: 1,
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-08-20T05:00:00.000Z",
        alaya_commit: "deadbee",
        embedding_provider: "none",
        embedding_mode: "disabled",
        questions: []
      } as never,
      recordedGitState: fakeGitState("aa".repeat(32))
    })).rejects.toThrow(/commit.*measured HEAD/iu);
  });

  it("writes a generic bench slug from one injected recorded state", async () => {
    const historyRoot = await mkdtemp(path.join(tmpdir(), "archive-git-self-"));
    roots.push(historyRoot);
    const measurer = mutatingMeasurer();
    const result = await writeBenchArchive({
      identity: {
        benchName: "public",
        split: "longmemeval-s",
        diagnosticsFilename: "diagnostics.json"
      },
      historyRoot,
      runAt: new Date("2026-08-20T05:00:00.000Z"),
      commitSha7: "9e331fa",
      payload: makeShardKpi({ alaya_commit: "9e331fa" }),
      diagnosticsPayload: {
        schema_version: 1,
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-08-20T05:00:00.000Z",
        alaya_commit: "9e331fa",
        embedding_provider: "none",
        embedding_mode: "disabled",
        questions: []
      } as never,
      recordedGitState: fakeGitState("aa".repeat(32)),
      measureGitState: measurer.measure
    });
    expect(measurer.calls).toBe(0);
    expect(result.slug).toBe(`2026-08-20T050000Z-9e331fa-wt-${"aa".repeat(32)}`);
  });

  it("does not re-measure when composing a generic bench slug", async () => {
    const historyRoot = await mkdtemp(path.join(tmpdir(), "archive-git-once-"));
    roots.push(historyRoot);
    const measurer = mutatingMeasurer();
    const result = await writeBenchArchive({
      identity: {
        benchName: "public",
        split: "longmemeval-s",
        diagnosticsFilename: "diagnostics.json"
      },
      historyRoot,
      runAt: new Date("2026-08-20T05:00:00.000Z"),
      commitSha7: "9e331fa",
      payload: makeShardKpi({ alaya_commit: "9e331fa" }),
      diagnosticsPayload: {
        schema_version: 1,
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-08-20T05:00:00.000Z",
        alaya_commit: "9e331fa",
        embedding_provider: "none",
        embedding_mode: "disabled",
        questions: []
      } as never,
      measureGitState: measurer.measure
    });
    expect(measurer.calls).toBe(1);
    expect(result.slug).toContain(`wt-${"aa".repeat(32)}`);
    expect(result.slug).not.toContain(`wt-${"bb".repeat(32)}`);
  });

  it("writes a merged archive slug from one injected recorded state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archive-git-merge-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-merge", 0);
    const spool = await LongMemEvalDiagnosticsSpool.create();
    const measurer = mutatingMeasurer();
    try {
      const loaded = await loadMergeShards([shard], spool);
      const written = await writeMergedLongMemEvalArchive({
        historyRoot: path.join(root, "history"),
        build: buildMergedLongMemEvalPayload(loaded),
        shardArchiveRefs: loaded.archiveRefs,
        diagnosticsSpool: spool,
        recordedGitState: fakeGitState("aa".repeat(32), "deadbee"),
        measureGitState: measurer.measure
      });
      expect(measurer.calls).toBe(0);
      expect(written.slug).toContain("-9e331fa-");
      expect(written.slug).not.toContain("-deadbee-");
      expect(written.slug).toContain(`wt-${"aa".repeat(32)}`);
      expect(written.slug).not.toContain(`wt-${"bb".repeat(32)}`);
    } finally {
      await spool.dispose();
    }
  });

  it("measures merge-time git once for the slug", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archive-git-merge-once-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-merge", 0);
    const spool = await LongMemEvalDiagnosticsSpool.create();
    const measurer = mutatingMeasurer();
    try {
      const loaded = await loadMergeShards([shard], spool);
      const written = await writeMergedLongMemEvalArchive({
        historyRoot: path.join(root, "history"),
        build: buildMergedLongMemEvalPayload(loaded),
        shardArchiveRefs: loaded.archiveRefs,
        diagnosticsSpool: spool,
        measureGitState: measurer.measure
      });
      expect(measurer.calls).toBe(1);
      expect(written.slug).toContain(`wt-${"aa".repeat(32)}`);
      expect(written.slug).not.toContain(`wt-${"bb".repeat(32)}`);
    } finally {
      await spool.dispose();
    }
  });
});

function mutatingMeasurer(): {
  readonly calls: number;
  readonly measure: (checkoutRoot: string) => Promise<MeasuredGitState>;
} {
  let calls = 0;
  const states = [fakeGitState("aa".repeat(32)), fakeGitState("bb".repeat(32))];
  return {
    get calls() {
      return calls;
    },
    measure: async () => {
      const state = states[Math.min(calls, states.length - 1)]!;
      calls += 1;
      return state;
    }
  };
}

function fakeGitState(digest: string, commitSha7 = "9e331fa"): MeasuredGitState {
  return {
    commitSha: `${commitSha7}${"0".repeat(33)}`,
    commitSha7,
    worktreeStateSha256: digest,
    worktreeStateAlgorithm: "sha256-worktree-state-v3",
    worktreeClean: false
  };
}
