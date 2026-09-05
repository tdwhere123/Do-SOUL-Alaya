import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import {
  SOURCE_BOUND_F3_EVIDENCE_PROMPT_SHA256,
  SOURCE_BOUND_F3_EVIDENCE_REQUEST_TEMPLATE_SHA256,
  SOURCE_BOUND_F3_QUERY_PROMPT_SHA256,
  SOURCE_BOUND_F3_QUERY_REQUEST_TEMPLATE_SHA256
} from "@do-soul/alaya-soul";
import { checkpointDigest } from "../../../runs/diagnostic-loop/checkpoint.js";

export const execFileAsync = promisify(execFile);
export const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/recall-any5-mimo-loop.sh"
);
const DIGEST = "ab".repeat(32);
const CREDENTIAL_ENV_KEYS = [
  "ALAYA_OFFICIAL_GARDEN_SECRET_REF",
  "ALAYA_OFFICIAL_GARDEN_API_KEY",
  "OFFICIAL_API_GARDEN_API_KEY",
  "ALAYA_QA_API_KEY",
  "ALAYA_GARDEN_OPENAI_SECRET_REF",
  "ALAYA_CONFLICT_LLM_PROVIDER_URL",
  "ALAYA_CONFLICT_LLM_API_KEY"
] as const;
const ABSENT_CREDENTIALS = Object.fromEntries(
  CREDENTIAL_ENV_KEYS.map((key) => [key, false])
) as Record<(typeof CREDENTIAL_ENV_KEYS)[number], false>;

export interface OperatorLoopHarness {
  readonly snapshot: string;
  readonly workRoot: string;
  readonly argvCapture: string;
  readonly envCapture: string;
  readonly envFile: string;
  readonly binDir: string;
  readonly env: NodeJS.ProcessEnv;
}

interface CapturedLoopEnv {
  readonly credentials: Record<(typeof CREDENTIAL_ENV_KEYS)[number], boolean>;
  readonly ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: string | null;
  readonly ALAYA_GARDEN_PROVIDER_KIND: string | null;
}

export function diagnosticArgs(
  harness: OperatorLoopHarness,
  reuse: boolean
): string[] {
  return reuse
    ? [
        "diagnostic",
        "--limit",
        "1",
        "--snapshot",
        harness.snapshot,
        "--work-root",
        harness.workRoot
      ]
    : ["diagnostic", "--limit", "1", "--work-root", harness.workRoot];
}

export async function expectRejectedBeforeLoop(
  harness: OperatorLoopHarness,
  args: readonly string[],
  stderr: string
): Promise<void> {
  await expect(execFileAsync("bash", [script, ...args], {
    env: harness.env,
    timeout: 10_000
  })).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining(stderr)
  });
  await expect(access(harness.argvCapture)).rejects.toMatchObject({ code: "ENOENT" });
}

export async function invokeDiagnosticLoop(
  harness: OperatorLoopHarness,
  args: readonly string[]
): Promise<string[]> {
  try {
    await execFileAsync("bash", [script, "diagnostic", ...args], {
      env: harness.env,
      timeout: 10_000
    });
  } catch (error) {
    const failed = error as { code?: number; stderr?: string; stdout?: string };
    throw new Error(
      `expected diagnostic-loop invocation, got exit ${String(failed.code)}: ${failed.stderr ?? ""} ${failed.stdout ?? ""}`
    );
  }
  try {
    return JSON.parse(await readFile(harness.argvCapture, "utf8")) as string[];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`argv capture missing at ${harness.argvCapture}: ${reason}`);
  }
}

export async function expectCacheOnlyLoopEnv(
  harness: OperatorLoopHarness,
  argv: readonly string[]
): Promise<void> {
  expect(flagValue(argv, "--mode")).toBe("cache-only");
  expect(flagValue(argv, "--request-manifest")).toBeDefined();
  expect(argv).not.toContain("--requested-keys");
  const captured = JSON.parse(await readFile(harness.envCapture, "utf8")) as CapturedLoopEnv;
  expect(captured.credentials).toEqual(ABSENT_CREDENTIALS);
  expect(captured.ALAYA_BENCH_ALLOW_LIVE_EXTRACTION).toBe("0");
  expect(captured.ALAYA_GARDEN_PROVIDER_KIND).toBe("host_worker");
}

export async function writeOperatorLoopHarness(
  tmpDir: string,
  workName = "new-work"
): Promise<OperatorLoopHarness> {
  const g2 = path.join(tmpDir, "g2");
  const cacheRoot = path.join(g2, "cache-100q");
  const snapshot = path.join(tmpDir, "sealed-reuse", "snapshot.db");
  const workRoot = path.join(tmpDir, workName);
  const argvCapture = path.join(tmpDir, `${workName}-diagnostic-loop-argv.json`);
  const envCapture = path.join(tmpDir, `${workName}-diagnostic-loop-env.json`);
  const envFile = path.join(tmpDir, "bench.env");
  const binDir = path.join(tmpDir, "fake-bin");
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(path.dirname(snapshot), { recursive: true });
  await mkdir(workRoot, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(cacheRoot, "manifest.json"), `${JSON.stringify({
    dataset_revision: DIGEST,
    extraction_model: "mimo-v2.5",
    request_profile: "mimo-v2.5-nonthinking-v1",
    system_prompt_sha256: DIGEST,
    provider_url: "https://fixture-provider.invalid/v1"
  })}\n`);
  await writeFile(path.join(g2, "diagnostic-identity.json"), `${JSON.stringify({
    schema_digest: DIGEST,
    operator_digest: DIGEST,
    requested_key: "cd".repeat(32)
  })}\n`);
  await writeFile(snapshot, "fixture-snapshot\n");
  const interceptPath = await writeFakeNode(binDir, argvCapture, envCapture);
  await writeFile(envFile, [
    bashAssignment("ALAYA_BENCH_EXTRACTION_CACHE_ROOT", cacheRoot),
    "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION=1",
    "ALAYA_GARDEN_PROVIDER_KIND=official_api",
    ...CREDENTIAL_ENV_KEYS.map((key) => `${key}=fixture-${key}`),
    bashAssignment("BENCH_NODE_BIN", process.execPath),
    bashAssignment("BENCH_NODE_INTERCEPT", interceptPath),
    bashAssignment("BENCH_NODE_ARGV_CAPTURE", argvCapture),
    bashAssignment("BENCH_NODE_ENV_CAPTURE", envCapture),
    ""
  ].join("\n"));
  return {
    snapshot,
    workRoot,
    argvCapture,
    envCapture,
    envFile,
    binDir,
    env: isolatedChildEnv(envFile, interceptPath, argvCapture, envCapture)
  };
}

export async function writeReplayAwareNode(
  binDir: string,
  receipt: Readonly<Record<string, unknown>> = replayReceiptFixture()
): Promise<void> {
  await writeExecutableNode(binDir, [
    "#!/usr/bin/env node",
    "\"use strict\";",
    "const { readFileSync, writeFileSync } = require(\"fs\");",
    "const { spawnSync } = require(\"child_process\");",
    "const args = process.argv.slice(2);",
    `const expectedReceipt = ${JSON.stringify(replayReceiptFixture())};`,
    `const receipt = ${JSON.stringify(receipt)};`,
    `const credentialKeys = ${JSON.stringify(CREDENTIAL_ENV_KEYS)};`,
    "const runner = args[0] ?? \"\";",
    "function flagValue(name) {",
    "  const index = args.indexOf(name);",
    "  return index >= 0 ? args[index + 1] : undefined;",
    "}",
    "function passthrough() {",
    "  const result = spawnSync(process.execPath, args, { stdio: \"inherit\", env: process.env });",
    "  process.exit(result.status === null ? 1 : result.status);",
    "}",
    "if (runner === \"-\" || runner === \"-e\") passthrough();",
    "if (runner.includes(\"prove-cache-only-replay.mjs\")) {",
    "  const output = args[1];",
    "  if (!output) { process.stderr.write(\"request manifest output\\n\"); process.exit(1); }",
    "  writeFileSync(output, JSON.stringify({",
    "    schema_version: 1, kind: \"provider_preflight_replay_request\"",
    "  }) + \"\\n\");",
    "  process.exit(0);",
    "}",
    "if (runner.includes(\"alaya-bench-runner.mjs\") && args[1] === \"provider-preflight\") {",
    "  if (!args.includes(\"--request-manifest\")) {",
    "    process.stderr.write(\"missing complete request manifest\\n\");",
    "    process.exit(2);",
    "  }",
    "  if (flagValue(\"--mode\") === \"validate-replay-receipt\") {",
    "    const actualReceipt = JSON.parse(readFileSync(flagValue(\"--receipt\"), \"utf8\"));",
    "    const actualRequest = JSON.parse(readFileSync(flagValue(\"--request-manifest\"), \"utf8\"));",
    "    if (JSON.stringify(actualReceipt) !== JSON.stringify(expectedReceipt)) process.exit(1);",
    "    if (JSON.stringify(actualRequest) !== JSON.stringify({",
    "      schema_version: 1, kind: \"provider_preflight_replay_request\"",
    "    })) process.exit(1);",
    "    process.exit(0);",
    "  }",
    "  if (credentialKeys.some((key) => process.env[key])) {",
    "    process.stderr.write(\"provider credentials reached replay\\n\");",
    "    process.exit(2);",
    "  }",
    "  if (process.env.ALAYA_BENCH_ALLOW_LIVE_EXTRACTION !== \"0\") {",
    "    process.stderr.write(\"live extraction reached replay\\n\");",
    "    process.exit(2);",
    "  }",
    "  process.stdout.write(JSON.stringify(receipt) + \"\\n\");",
    "  process.exit(0);",
    "}",
    "process.stderr.write(\"unexpected node invocation\\n\");",
    "process.exit(2);",
    ""
  ].join("\n"));
}

export function replayReceiptFixture(): Readonly<Record<string, unknown>> {
  return {
    schema_version: 2,
    kind: "provider_preflight_replay_receipt",
    provider_port: "absent",
    physical_calls: 0,
    model: "mimo-v2.5",
    profile: "mimo-v2.5-nonthinking-v1",
    key_count: 1,
    request_manifest_sha256: DIGEST,
    cache_manifest_sha256: DIGEST,
    evidence_prompt_sha256: SOURCE_BOUND_F3_EVIDENCE_PROMPT_SHA256,
    query_prompt_sha256: SOURCE_BOUND_F3_QUERY_PROMPT_SHA256,
    evidence_request_template_sha256: SOURCE_BOUND_F3_EVIDENCE_REQUEST_TEMPLATE_SHA256,
    query_request_template_sha256: SOURCE_BOUND_F3_QUERY_REQUEST_TEMPLATE_SHA256
  };
}

export async function writeCompletedRecallCheckpoint(
  workRoot: string,
  phase: "control_recall" | "treatment_recall" = "control_recall"
): Promise<void> {
  await writeRecallCheckpoint(workRoot, phase, "completed");
}

export async function writeFailedRecallCheckpoint(
  workRoot: string,
  phase: "control_recall" | "treatment_recall" = "control_recall"
): Promise<void> {
  await writeRecallCheckpoint(workRoot, phase, "failed");
}

async function writeRecallCheckpoint(
  workRoot: string,
  phase: "control_recall" | "treatment_recall",
  status: "completed" | "failed"
): Promise<void> {
  const dir = path.join(workRoot, "checkpoints");
  await mkdir(dir, { recursive: true });
  const body = {
    schema_version: 3 as const,
    kind: "diagnostic_loop_checkpoint" as const,
    phase,
    status,
    identity_digest: DIGEST,
    content_identity: DIGEST,
    depends_on: {},
    physical_calls: 0,
    avoided_work: {
      phasesSkipped: 0,
      providerCallsAvoided: 0,
      questionsSkipped: 0,
      snapshotsReused: 0
    },
    artifact_paths: {
      snapshot: path.join(workRoot, "snapshot.db"),
      kpi: path.join(workRoot, `${phase}-kpi.json`),
      report: path.join(workRoot, `${phase}-report.json`),
      diagnostics: path.join(workRoot, `${phase}-diagnostics.json`)
    },
    details: {
      no_provider_call_receipt: {
        schema_version: 1,
        kind: "internal_no_provider_port",
        provider_port: "absent",
        physical_calls: 0
      }
    },
    completed_at: "2026-08-19T00:00:00.000Z"
  };
  await writeFile(
    path.join(dir, `${phase}.json`),
    `${JSON.stringify({ ...body, checkpoint_digest: checkpointDigest(body) })}\n`,
    "utf8"
  );
}

export async function writeParseableRecallCheckpoint(
  workRoot: string,
  payload: unknown
): Promise<void> {
  const dir = path.join(workRoot, "checkpoints");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "control_recall.json"), `${JSON.stringify(payload)}\n`, "utf8");
}

export async function writeTruncatedRecallCheckpoint(workRoot: string): Promise<void> {
  const dir = path.join(workRoot, "checkpoints");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "control_recall.json"), '{"status":"completed"', "utf8");
}

export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

async function writeFakeNode(
  binDir: string,
  argvCapture: string,
  envCapture: string
): Promise<string> {
  return writeExecutableNode(binDir, fakeNodeScript(argvCapture, envCapture));
}

async function writeExecutableNode(binDir: string, source: string): Promise<string> {
  const interceptPath = path.join(binDir, "node-intercept.cjs");
  await writeFile(interceptPath, source, "utf8");
  return interceptPath;
}

function fakeNodeScript(argvCapture: string, envCapture: string): string {
  return [
    "\"use strict\";",
    "const { writeFileSync } = require(\"fs\");",
    "const { spawnSync } = require(\"child_process\");",
    "const { createHash } = require(\"crypto\");",
    "const args = process.argv.slice(2);",
    `const argvCapture = process.env.BENCH_NODE_ARGV_CAPTURE || ${JSON.stringify(argvCapture)};`,
    `const envCapture = process.env.BENCH_NODE_ENV_CAPTURE || ${JSON.stringify(envCapture)};`,
    `const digest = ${JSON.stringify(DIGEST)};`,
    `const credentialKeys = ${JSON.stringify(CREDENTIAL_ENV_KEYS)};`,
    "function hasFlag(name, value) {",
    "  for (let i = 0; i < args.length - 1; i++) {",
    "    if (args[i] === name && args[i + 1] === value) return true;",
    "  }",
    "  return false;",
    "}",
    "function passthrough() {",
    "  const result = spawnSync(process.execPath, args, { stdio: \"inherit\", env: process.env });",
    "  process.exit(result.status === null ? 1 : result.status);",
    "}",
    "const runner = args[0] ?? \"\";",
    "if (runner === \"-\" || runner === \"-e\") passthrough();",
    "if (args.includes(\"diagnostic-loop\")) {",
    "  writeFileSync(argvCapture, JSON.stringify(args) + \"\\n\");",
    "  writeFileSync(envCapture, JSON.stringify({",
    "    credentials: Object.fromEntries(credentialKeys.map((key) => [key, Boolean(process.env[key])])),",
    "    ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: process.env.ALAYA_BENCH_ALLOW_LIVE_EXTRACTION ?? null,",
    "    ALAYA_GARDEN_PROVIDER_KIND: process.env.ALAYA_GARDEN_PROVIDER_KIND ?? null",
    "  }) + \"\\n\");",
    "  process.exit(0);",
    "}",
    "if (runner.includes(\"alaya-bench-runner.mjs\") && hasFlag(\"--mode\", \"validate-recall-checkpoints\")) {",
    "  passthrough();",
    "}",
    "if (runner.includes(\"prove-cache-only-replay.mjs\")) {",
    "  writeFileSync(args[1], JSON.stringify({",
    "    schema_version: 1,",
    "    kind: \"provider_preflight_replay_request\",",
    "    request: { requestedKeys: [digest], schemaDigest: digest, operatorDigest: digest },",
    "    canonical_keys: {",
    "      count: 1,",
    "      key_set_sha256: createHash(\"sha256\").update(digest, \"utf8\").digest(\"hex\")",
    "    }",
    "  }) + \"\\n\");",
    "  process.exit(0);",
    "}",
    "passthrough();",
    ""
  ].join("\n");
}

function isolatedChildEnv(
  envFile: string,
  interceptPath: string,
  argvCapture: string,
  envCapture: string
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("ALAYA_") ||
      key.startsWith("OFFICIAL_") ||
      key.startsWith("npm_") ||
      key.startsWith("VITEST")
    ) {
      delete env[key];
    }
  }
  delete env.NODE_OPTIONS;
  return {
    ...env,
    BENCH_NODE_BIN: posixPath(process.execPath),
    BENCH_NODE_INTERCEPT: posixPath(interceptPath),
    BENCH_NODE_ARGV_CAPTURE: posixPath(argvCapture),
    BENCH_NODE_ENV_CAPTURE: posixPath(envCapture),
    ALAYA_RECALL_ANY5_ENV: posixPath(envFile)
  };
}

function posixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function bashAssignment(name: string, value: string): string {
  const posix = posixPath(value);
  return `${name}='${posix.replaceAll("'", "'\\''")}'`;
}
