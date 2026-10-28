import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveDefaultBenchHistoryRoot } from "@do-soul/alaya-eval";
import { parseFlags } from "../../cli/cli-options.js";

describe("parseFlags", () => {
  it("honors inline cohort and boolean flag values without silently broadening the run", () => {
    expect(parseFlags(["--variant=s", "--limit=100", "--offset=25", "--force=true", "--qa=off"]))
      .toMatchObject({ variant: "longmemeval_s", limit: 100, offset: 25, force: true, qa: false });
  });

  it.each([["--limti=100"], ["--variant", "unknown"], ["--variant=unknown"], ["--qa=maybe"], ["--limit"], ["--variant"]])(
    "refuses unknown, malformed, or missing benchmark intent: %j", (...args) => {
      expect(() => parseFlags(args)).toThrow();
    }
  );
  it("uses local ignored history and retains explicit history and static input paths", () => {
    expect(parseFlags([]).historyRoot).toBe(path.resolve(process.cwd(), ".bench-artifacts/history"));
    expect(parseFlags([]).historyRoot).toBe(resolveDefaultBenchHistoryRoot());
    const parsed = parseFlags(["--history-root", "legacy/history", "--pinned-meta-root", "docs/bench-history/datasets",
      "--question-manifest", "docs/bench-history/datasets/longmemeval_s.stratified-100.v1.json"]);
    expect(parsed.historyRoot).toBe("legacy/history");
    expect(parsed.pinnedMetaRoot).toBe("docs/bench-history/datasets");
    expect(parsed.questionManifest).toBe("docs/bench-history/datasets/longmemeval_s.stratified-100.v1.json");
  });

  it.each([["--history-root"], ["--history-root", ""], ["--history-root", "--limit", "1"]])(
    "rejects a history override without a path: %j", (...args) => {
      expect(() => parseFlags(args)).toThrow("--history-root requires a path value");
    }
  );

  it("defaults the benchmark embedding provider to local ONNX", () => {
    expect(parseFlags([]).embeddingProviderKind).toBe("local_onnx");
  });

  it("collects shard paths until the next flag and resolves variant aliases", () => {
    const parsed = parseFlags([
      "--variant",
      "s",
      "--shards",
      "shard-a",
      "shard-b",
      "--limit",
      "2",
      "--edge-plane"
    ]);

    expect(parsed.variant).toBe("longmemeval_s");
    expect(parsed.shards).toEqual(["shard-a", "shard-b"]);
    expect(parsed.limit).toBe(2);
    expect(parsed.edgePlane).toBe(true);
  });

  it("parses inline long flags for provider, policy, snapshot, and concurrency", () => {
    const parsed = parseFlags([
      "--embedding",
      "env",
      "--embedding-provider=local_onnx",
      "--policy-shape=chat",
      "--simulate-report=mixed",
      "--snapshot=/tmp/snapshot.db",
      "--snapshot-out=/tmp/out.db",
      "--data-dir-root=/tmp/data-dir",
      "--materialize-question-dbs",
      "--pinned-meta-root=/tmp/pinned",
      "--question-manifest=/tmp/questions.json",
      "--extraction-cache-root=/tmp/cache",
      "--experiment",
      "--backfill-missing-fact-frame-formations",
      "--expansion-spend-approval=/tmp/expansion-spend-approval.json",
      "--concurrency=4",
      "--expected-reconciliation-basis=rule_only",
      "--extraction-initial-concurrency=8",
      "--question-batch-limit=100",
      "--tolerate-provider-task-failures"
    ]);

    expect(parsed.embeddingMode).toBe("env");
    expect(parsed.embeddingProviderKind).toBe("local_onnx");
    expect(parsed.policyShape).toBe("chat");
    expect(parsed.simulateReport).toBe("mixed");
    expect(parsed.weightOverridesJson).toBeUndefined();
    expect(parsed.snapshot).toBe("/tmp/snapshot.db");
    expect(parsed.snapshotOut).toBe("/tmp/out.db");
    expect(parsed.dataDirRoot).toBe("/tmp/data-dir");
    expect(parsed.materializeQuestionDbs).toBe(true);
    expect(parsed.pinnedMetaRoot).toBe("/tmp/pinned");
    expect(parsed.questionManifest).toBe("/tmp/questions.json");
    expect(parsed.extractionCacheRoot).toBe("/tmp/cache");
    expect(parsed.experiment).toBe(true);
    expect(parsed.backfillMissingFactFrameFormations).toBe(true);
    expect(parsed.expansionSpendApproval).toBe("/tmp/expansion-spend-approval.json");
    expect(parsed.concurrency).toBe(4);
    expect(parsed.expectedReconciliationBasis).toBe("rule_only");
    expect(parseFlags([
      "--expected-reconciliation-basis", "garden_llm"
    ]).expectedReconciliationBasis).toBe("garden_llm");
    expect(parsed.extractionInitialConcurrency).toBe(8);
    expect(parsed.questionBatchLimit).toBe(100);
    expect(parsed.tolerateProviderTaskFailures).toBe(true);
  });

  it("rejects invalid enumerated options", () => {
    expect(() => parseFlags(["--embedding-provider", "bogus"])).toThrow(
      "--embedding-provider must be one of: openai, local_onnx"
    );
    expect(() => parseFlags(["--policy-shape", "wide"])).toThrow(
      "--policy-shape must be one of: stress, chat"
    );
    expect(() => parseFlags(["--simulate-report", "goldish"])).toThrow(
      "--simulate-report must be one of: none, always-used, gold-only, mixed"
    );
    expect(() => parseFlags(["--expected-reconciliation-basis", "hybrid"])).toThrow(
      "--expected-reconciliation-basis must be one of: rule_only, garden_llm"
    );
    expect(() => parseFlags(["--expected-reconciliation-basis"])).toThrow(
      "--expected-reconciliation-basis requires a value"
    );
    expect(() => parseFlags(["--question-manifest"])).toThrow(
      "--question-manifest requires a path"
    );
    expect(() => parseFlags(["--expansion-spend-approval", "--limit", "500"])).toThrow(
      "--expansion-spend-approval requires a path"
    );
    expect(parseFlags([
      "--r3-spend-approval=/tmp/expansion-spend-approval.json"
    ]).expansionSpendApproval).toBe("/tmp/expansion-spend-approval.json");
    expect(() => parseFlags(["--r3-spend-approval", "--limit", "500"])).toThrow(
      "--r3-spend-approval requires a path"
    );
    expect(() => parseFlags([
      "--expansion-spend-approval=/tmp/a.json",
      "--r3-spend-approval=/tmp/b.json"
    ])).toThrow("--expansion-spend-approval may be provided only once");
    expect(() => parseFlags([
      "--extraction-predecessor-authority", "/tmp/a.json",
      "--extraction-predecessor-authority=/tmp/b.json"
    ])).toThrow("--extraction-predecessor-authority may be provided only once");
  });
});
