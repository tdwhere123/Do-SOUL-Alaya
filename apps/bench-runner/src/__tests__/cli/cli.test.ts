import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";

describe("bench-runner CLI", () => {
  const canonicalSlugPattern = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/;

  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let stdoutBuf: string;
  let stderrBuf: string;

  beforeEach(() => {
    stdoutBuf = "";
    stderrBuf = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutBuf += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  it("mentions controlled-replay in help output", async () => {
    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdoutBuf).toContain("controlled-replay");
    expect(stdoutBuf).toContain("--policy-shape stress|chat");
    expect(stdoutBuf).toContain("--simulate-report none|always-used|gold-only|mixed");
    expect(stdoutBuf).toContain("--weights '<json>'");
    expect(stdoutBuf).toContain("--data-dir <path>");
    expect(stdoutBuf).toContain("--force");
    expect(stdoutBuf).toContain("--edge-plane");
  });

  it("mentions extraction-fill and recall-eval in help output", async () => {
    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdoutBuf).toContain("extraction-fill");
    expect(stdoutBuf).not.toContain("recover-extraction-attempt-ledger");
    expect(stdoutBuf).toContain("recall-eval --snapshot <db>");
    expect(stdoutBuf).toContain("--experiment");
    expect(stdoutBuf).toContain("--legacy-manifest-sha256 <sha>");
    expect(stdoutBuf).toContain("--legacy-dataset-sha256 <sha>");
    expect(stdoutBuf).toContain("--concurrency N");
    expect(stdoutBuf).toContain("--direct-deepseek-500-operator <operator>");
    expect(stdoutBuf).toContain("--direct-newapi-deepseek-500-operator <operator>");
    expect(stdoutBuf).toMatch(/longmemeval[\s\S]*--concurrency N/);
  });

  it("does not dispatch stopped extraction ledger recovery", async () => {
    expect(await runCli(["recover-extraction-attempt-ledger"])).toBe(2);
    expect(stderrBuf).toContain(
      "unknown command 'recover-extraction-attempt-ledger'"
    );
  });

  it("documents the extraction cache audit", async () => {
    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdoutBuf).toContain("audit-extraction-cache");
    expect(stdoutBuf).toContain("--rebuild-cache-root <new-root>");
    expect(stdoutBuf).toContain("--cache-audit-output <new-dir>");
    expect(stdoutBuf).toContain("--target-model <model>");
    expect(stdoutBuf).toContain("--target-model-family <family>");
    expect(stdoutBuf).toContain("--target-request-profile <profile>");
    expect(stdoutBuf).toContain("--target-provider-url <url>");
  });

  it("documents and dispatches the fact-frame formation audit", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(stdoutBuf).toContain(
      "fact-frame-formation-audit --snapshot <db> [--output <json>]"
    );

    stdoutBuf = "";
    expect(await runCli(["fact-frame-formation-audit"])).toBe(2);
    expect(stderrBuf).toContain(
      "fact-frame-formation-audit: --snapshot <db> required"
    );
  });

  it("documents and dispatches object-key retrofit", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(stdoutBuf).toContain(
      "retrofit-object-keys --snapshot <scratch.sqlite> [--output <json>]"
    );

    stdoutBuf = "";
    expect(await runCli(["retrofit-object-keys"])).toBe(2);
    expect(stderrBuf).toContain(
      "retrofit-object-keys: --snapshot <db> required"
    );
  });

  it("documents and dispatches the selection order ledger", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(stdoutBuf).toContain(
      "selection-order-ledger --selection-boundaries <ndjson.gz>"
    );

    stdoutBuf = "";
    expect(await runCli(["selection-order-ledger"])).toBe(2);
    expect(stderrBuf).toContain("--selection-boundaries <value> required");
  });

  it("documents captured-score fidelity flags and rejects an unknown mode", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(stdoutBuf).toContain("--captured-score-fidelity assert|recompute-live");
    expect(stdoutBuf).toContain("--gold-map <gold.json>");

    stdoutBuf = "";
    expect(await runCli([
      "selection-order-ledger",
      "--selection-boundaries", "/tmp/boundaries.ndjson.gz",
      "--selection-boundaries-sha256", "0".repeat(64),
      "--expected-question-count", "1",
      "--expected-question-id-digest", "1".repeat(64),
      "--output", "/tmp/ledger.ndjson.gz",
      "--captured-score-fidelity", "recompute_live"
    ])).toBe(2);
    expect(stderrBuf).toContain(
      "--captured-score-fidelity must be assert or recompute-live"
    );
  });

  it("refuses a gold map on the default selection-order-ledger path", async () => {
    expect(await runCli([
      "selection-order-ledger",
      "--selection-boundaries", "/tmp/boundaries.ndjson.gz",
      "--selection-boundaries-sha256", "0".repeat(64),
      "--expected-question-count", "1",
      "--expected-question-id-digest", "1".repeat(64),
      "--output", "/tmp/ledger.ndjson.gz",
      "--gold-map", "/tmp/gold.json"
    ])).toBe(2);
    expect(stderrBuf).toContain(
      "gold map applies only to captured-score-fidelity recompute-live"
    );
  });

  it("refuses recompute-live without a gold map", async () => {
    expect(await runCli([
      "selection-order-ledger",
      "--selection-boundaries", "/tmp/boundaries.ndjson.gz",
      "--selection-boundaries-sha256", "0".repeat(64),
      "--expected-question-count", "1",
      "--expected-question-id-digest", "1".repeat(64),
      "--output", "/tmp/ledger.ndjson.gz",
      "--captured-score-fidelity", "recompute-live"
    ])).toBe(2);
    expect(stderrBuf).toContain("recompute_live requires a gold map");
  });

  it("dispatches the extraction cache audit command", async () => {
    const exitCode = await runCli(["audit-extraction-cache"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toContain("alaya-bench-runner audit-extraction-cache:");
  });

  it("recall-eval without --snapshot exits 2 with an actionable message", async () => {
    const exitCode = await runCli(["recall-eval", "--variant", "s"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/--snapshot <db> required/);
  });

  it("requires both external trust anchors for a legacy snapshot", async () => {
    const exitCode = await runCli([
      "recall-eval", "--snapshot", "/tmp/legacy.db", "--legacy-snapshot"
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/requires --data-dir, --legacy-manifest-sha256, and --legacy-dataset-sha256/u);
  });

  it("rejects orphan legacy trust anchors on the current snapshot path", async () => {
    const exitCode = await runCli([
      "recall-eval", "--snapshot", "/tmp/current.db",
      "--legacy-manifest-sha256", "a".repeat(64)
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/legacy SHA-256 flags require --legacy-snapshot/u);
  });

  it("rejects invalid embedding modes instead of silently disabling embeddings", async () => {
    const exitCode = await runCli(["longmemeval", "--embedding", "evn"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/--embedding must be one of: disabled, env/);
  });

  it("rejects invalid LongMemEval policy shapes", async () => {
    const exitCode = await runCli(["longmemeval", "--policy-shape", "wide-chat"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/--policy-shape must be one of: stress, chat/);
  });

  it("rejects invalid LongMemEval simulate-report modes", async () => {
    const exitCode = await runCli(["longmemeval", "--simulate-report", "goldish"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(
      /--simulate-report must be one of: none, always-used, gold-only, mixed/
    );
  });

  it("rejects malformed LongMemEval concurrency values instead of falling back", async () => {
    const exitCode = await runCli(["longmemeval", "--concurrency", "2.5"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/--concurrency must be a positive integer/);
  });

  it("rejects a continuation predecessor flag on unrelated commands", async () => {
    const exitCode = await runCli([
      "longmemeval", "--extraction-predecessor-authority", "/tmp/parent.json"
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/only valid for continuation extraction commands/u);
  });

  it("rejects a catalog refill allowlist on unrelated commands", async () => {
    const exitCode = await runCli([
      "longmemeval", "--catalog-refill-allowlist", "/tmp/allowlist.json"
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/only valid for authorize-extraction/u);
  });

  it("rejects experiment mode on unrelated commands", async () => {
    const exitCode = await runCli(["longmemeval", "--experiment"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/--experiment is only valid for recall-eval/u);
  });

  it("rejects invalid LongMemEval weight overrides before loading data", async () => {
    const exitCode = await runCli([
      "longmemeval",
      "--weights",
      JSON.stringify({ activation_weights_phase4b: { relevance: 0.2 } })
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/activation_weights_phase4b must sum to 1\.0/);
  });

  it(
    "controlled-replay writes a controlled-replay.json archive under a temp history root",
    async () => {
      const historyRoot = await mkdtemp(join(tmpdir(), "alaya-controlled-replay-cli-"));

      const exitCode = await runCli(["controlled-replay", "--history-root", historyRoot]);

      expect(exitCode).toBe(1);
      expect(stdoutBuf).toContain("Controlled replay");
      expect(stdoutBuf).toContain("Native health: fail");
      expect(stderrBuf).toContain(
        "controlled-replay native health gates failed: warm_usage_hit_at_5_gain"
      );
      const archivePath = stdoutBuf.match(/Archive: (.+controlled-replay\.json)/)?.[1];
      expect(archivePath).toBeDefined();
      expect(archivePath).toContain(join(historyRoot, "controlled-replay"));
      expect(basename(dirname(archivePath!))).toMatch(canonicalSlugPattern);
      const archive = JSON.parse(await readFile(archivePath!, "utf8")) as {
        readonly scenarios: readonly { readonly label: string }[];
        readonly contribution_suspects: readonly unknown[];
        readonly metrics: {
          readonly cold_warm_delta: unknown;
        };
        readonly native_health_gates: {
          readonly verdict: "ok" | "fail";
          readonly gates: readonly unknown[];
        };
        readonly evidence: {
          readonly harness_mode: string;
          readonly recall_path: string;
        };
      };
      expect(archive.scenarios.map((scenario) => scenario.label)).toEqual([
        "uniform-fact",
        "rotated-kind",
        "stress-policy-max10-conflict-true",
        "chat-policy-max10-conflict-false",
        "cold-report-context-usage-none",
        "warm-report-context-usage-mixed"
      ]);
      expect(archive.contribution_suspects).toHaveLength(3);
      expect(archive.metrics.cold_warm_delta).toBeDefined();
      expect(archive.native_health_gates.verdict).toBe("fail");
      expect(archive.native_health_gates.gates).toHaveLength(4);
      expect(archive.evidence.harness_mode).toBe("mcp_propose_review");
      expect(archive.evidence.recall_path).toBe("production_recall_service");
    },
    180_000
  );
});
