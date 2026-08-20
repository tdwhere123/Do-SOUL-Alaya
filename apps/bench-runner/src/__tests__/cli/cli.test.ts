import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";

describe("bench-runner CLI", () => {
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

  it("mentions the live LongMemEval-S and LoCoMo surfaces in help output", async () => {
    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdoutBuf).toContain("longmemeval [--variant");
    expect(stdoutBuf).toContain("locomo [--limit");
    expect(stdoutBuf).toContain("provider-preflight");
    expect(stdoutBuf).toContain(
      "provider-preflight --mode replay --request-manifest <json>"
    );
    expect(stdoutBuf).toContain("s       longmemeval_s (operator bench)");
    expect(stdoutBuf).not.toContain("controlled-replay");
    expect(stdoutBuf).not.toContain("longmemeval-multiturn");
    expect(stdoutBuf).not.toContain("mimo-preflight");
    expect(stdoutBuf).not.toContain("capture-parity");
    expect(stdoutBuf).not.toContain("selection-order-ledger");
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
    expect(stdoutBuf).toContain("diagnostic-loop --work-root <dir>");
    expect(stdoutBuf).toContain("extraction-fill");
    expect(stdoutBuf).not.toContain("recover-extraction-attempt-ledger");
    expect(stdoutBuf).toContain("recall-eval --snapshot <db>");
    expect(stdoutBuf).toContain("--experiment");
    expect(stdoutBuf).toContain("--embedding-cache-overlay <receipt.json>");
    expect(stdoutBuf).toContain("--query-semantic-factor-cache <json>");
    expect(stdoutBuf).toContain("--concurrency N");
    expect(stdoutBuf).not.toContain("--direct-deepseek-500-operator");
    expect(stdoutBuf).not.toContain("--direct-newapi-deepseek-500-operator");
    expect(stdoutBuf).not.toContain("--legacy-snapshot");
    expect(stdoutBuf).not.toContain("--legacy-manifest-sha256");
    expect(stdoutBuf).not.toContain("--legacy-dataset-sha256");
    expect(stdoutBuf).not.toContain("--catalog-refill-allowlist");
    expect(stdoutBuf).not.toContain("--promotion-contract");
    expect(stdoutBuf).toMatch(/longmemeval[\s\S]*--concurrency N/);
  });

  it("does not advertise retired campaign commands", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(stdoutBuf).not.toContain("authorize-longmemeval-matrix");
    expect(stdoutBuf).not.toContain("audit-extraction-cache");
    expect(stdoutBuf).not.toContain("materialize-audited-extraction-target");
    expect(stdoutBuf).not.toContain("fact-frame-formation-audit");
    expect(stdoutBuf).not.toContain("retrofit-object-keys");
    expect(stdoutBuf).not.toContain("query-semantic-factor-cache-fill");
    expect(stdoutBuf).not.toContain("embedding-cache-overlay-build");
  });

  it("does not dispatch stopped extraction ledger recovery", async () => {
    expect(await runCli(["recover-extraction-attempt-ledger"])).toBe(2);
    expect(stderrBuf).toContain(
      "unknown command 'recover-extraction-attempt-ledger'"
    );
  });

  it("does not dispatch retired campaign commands", async () => {
    for (const command of [
      "authorize-longmemeval-matrix",
      "audit-extraction-cache",
      "materialize-audited-extraction-target",
      "fact-frame-formation-audit",
      "retrofit-object-keys",
      "query-semantic-factor-cache-fill",
      "embedding-cache-overlay-build",
      "capture-parity",
      "selection-order-ledger"
    ]) {
      stderrBuf = "";
      expect(await runCli([command])).toBe(2);
      expect(stderrBuf).toContain(`unknown command '${command}'`);
    }
  });

  it("recall-eval without --snapshot exits 2 with an actionable message", async () => {
    const exitCode = await runCli(["recall-eval", "--variant", "s"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/--snapshot <db> required/);
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
});
