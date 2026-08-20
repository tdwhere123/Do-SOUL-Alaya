import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)),
  "fill-query-factors-process-fixture.mjs");
const SCRIPT = join(REPO_ROOT, "apps/bench-runner/scripts/fill-query-factors.mjs");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "query-factor-process-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fill-query-factors process operator", () => {
  it("sends the obligation and persists a formed graph with its receipt", async () => {
    const result = await run("success");
    expect(result.exitCode).toBe(0);
    const cache = JSON.parse(await readFile(result.outputPath, "utf8"));
    expect(cache.entries[0]).toMatchObject({
      capture: { status: "formed" },
      receipt: { query_producer_operator_id: "open_semantic_factor_query_compiler_v8" }
    });
    const request = JSON.parse(await readFile(result.requestPath, "utf8"));
    const body = JSON.parse(request.body);
    const userPrompt = JSON.parse(body.messages.at(-1).content);
    expect(userPrompt.semantic_completeness_obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2", constraints: [], arity: 2
    });
  });

  it("exits nonzero on terminal provider failure and preserves resumable state", async () => {
    const result = await run("provider-error");
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(result.outputPath)).toBe(false);
    expect(existsSync(join(`${result.outputPath}.partial`, "identity.json"))).toBe(true);
  });
});

async function run(mode: "success" | "provider-error") {
  const questionsPath = join(root, "questions.json");
  const outputPath = join(root, "query-cache.json");
  const requestPath = join(root, "request.json");
  await writeFile(questionsPath, JSON.stringify([{ question: "What did I buy?" }]), "utf8");
  const child = spawn(process.execPath, [FIXTURE, questionsPath, outputPath], {
    cwd: REPO_ROOT,
    env: { ...process.env,
      QUERY_FACTOR_PROCESS_MODE: mode,
      QUERY_FACTOR_REQUEST_PATH: requestPath,
      QUERY_FACTOR_SCRIPT_PATH: SCRIPT,
      OFFICIAL_API_GARDEN_PROVIDER_URL: "https://fixture.invalid/v1",
      OFFICIAL_API_GARDEN_MODEL: "fixture-model",
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1",
      ALAYA_OFFICIAL_GARDEN_SECRET_REF: "env:QUERY_FACTOR_PROCESS_KEY",
      QUERY_FACTOR_PROCESS_KEY: "fixture-key" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, outputPath, requestPath };
}
