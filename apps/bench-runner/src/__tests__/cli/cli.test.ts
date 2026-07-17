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
    expect(stdoutBuf).toContain("recall-eval --snapshot <db>");
    expect(stdoutBuf).toContain("--legacy-manifest-sha256 <sha>");
    expect(stdoutBuf).toContain("--legacy-dataset-sha256 <sha>");
    expect(stdoutBuf).toContain("--concurrency N");
    expect(stdoutBuf).toMatch(/longmemeval[\s\S]*--concurrency N/);
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

      expect(exitCode).toBe(0);
      expect(stdoutBuf).toContain("Controlled replay");
      expect(stdoutBuf).toContain("Native health: ok");
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
      expect(archive.native_health_gates.verdict).toBe("ok");
      expect(archive.native_health_gates.gates).toHaveLength(4);
      expect(archive.evidence.harness_mode).toBe("mcp_propose_review");
      expect(archive.evidence.recall_path).toBe("production_recall_service");
    },
    180_000
  );
});
