import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const VARIANT = "longmemeval_oracle";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "subprocess-fixture.mjs");
const SUBPROCESS_STARTUP_TIMEOUT_MS = 30_000;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "extraction-fill-process-"));
  await Promise.all([
    mkdir(join(root, "cache")),
    mkdir(join(root, "data")),
    mkdir(join(root, "pinned"))
  ]);
  await writeDataset();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("self-stops on a terminal task failure with a safe exit and no stale lease", async () => {
  const result = await runFixture("terminal");

  expect(result).toMatchObject({ exitCode: 1, signal: null, leaseSeenAtReady: true });
  expect(result.settlementMs).not.toBeNull();
  expect(result.settlementMs ?? Number.POSITIVE_INFINITY).toBeLessThan(1_500);
  expect(result.stderr).toContain(
    "retry_classification=failure_non_retryable_4xx"
  );
  expect(result.stderr).not.toMatch(/sk-fixture-secret|PROMPT_BODY/u);
  expect(existsSync(join(root, "cache", ".extraction-fill.lock"))).toBe(false);
}, 40_000);

it("settles a real SIGINT as exit 130 after releasing the lease", async () => {
  const result = await runFixture("signal", (child) => child.kill("SIGINT"));

  expect(result).toMatchObject({ exitCode: 130, signal: null, leaseSeenAtReady: true });
  expect(existsSync(join(root, "cache", ".extraction-fill.lock"))).toBe(false);
}, 40_000);

async function runFixture(
  mode: "terminal" | "signal",
  onReady?: (child: ReturnType<typeof spawn>) => void
): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null;
  readonly stdout: string; readonly stderr: string; readonly settlementMs: number | null;
  readonly leaseSeenAtReady: boolean }> {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      EXTRACTION_FILL_FIXTURE_ROOT: root,
      EXTRACTION_FILL_FIXTURE_MODE: mode,
      OFFICIAL_API_GARDEN_MODEL: "fixture-model",
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1",
      ALAYA_OFFICIAL_GARDEN_SECRET_REF: "env:E0_SUBPROCESS_GARDEN_KEY",
      E0_SUBPROCESS_GARDEN_KEY: "test-key"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let ready = false;
  let readyAt: number | null = null;
  let leaseSeenAtReady = false;
  // Source-graph startup is outside the settlement behavior asserted after FIXTURE_READY.
  const timeout = setTimeout(() => child.kill("SIGKILL"), SUBPROCESS_STARTUP_TIMEOUT_MS);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!ready && stdout.includes("FIXTURE_READY")) {
      ready = true;
      readyAt = Date.now();
      leaseSeenAtReady = existsSync(join(root, "cache", ".extraction-fill.lock"));
      onReady?.(child);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        settlementMs: readyAt === null ? null : Date.now() - readyAt,
        leaseSeenAtReady
      });
    });
  });
}

async function writeDataset(): Promise<void> {
  const questions = [{
    question_id: "q-process",
    question_type: "single_session",
    question: "What was saved?",
    answer: "alpha",
    question_date: "2026-01-01",
    haystack_session_ids: ["s-answer", "s-decoy"],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [{ role: "user", content: "alpha", has_answer: true }],
      [{ role: "user", content: "decoy" }]
    ],
    answer_session_ids: ["s-answer"]
  }];
  const raw = JSON.stringify(questions);
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  await writeFile(join(root, "data", `${VARIANT}.json`), raw, "utf8");
  await writeFile(
    join(root, "pinned", `${VARIANT}.meta.json`),
    JSON.stringify({ sha256, question_count: questions.length }),
    "utf8"
  );
}
