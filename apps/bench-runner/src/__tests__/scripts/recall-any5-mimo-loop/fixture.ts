import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";

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
    const failed = error as { code?: number; stderr?: string };
    throw new Error(
      `expected diagnostic-loop invocation, got exit ${String(failed.code)}: ${failed.stderr ?? ""}`
    );
  }
  return JSON.parse(await readFile(harness.argvCapture, "utf8")) as string[];
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
  await writeFile(envFile, [
    `ALAYA_BENCH_EXTRACTION_CACHE_ROOT=${cacheRoot}`,
    "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION=1",
    "ALAYA_GARDEN_PROVIDER_KIND=official_api",
    ...CREDENTIAL_ENV_KEYS.map((key) => `${key}=fixture-${key}`),
    ""
  ].join("\n"));
  await writeFile(snapshot, "fixture-snapshot\n");
  await writeFakeRtk(binDir, argvCapture, envCapture);
  return {
    snapshot,
    workRoot,
    argvCapture,
    envCapture,
    binDir,
    env: isolatedChildEnv(envFile, binDir)
  };
}

export async function writeReplayAwareRtk(
  binDir: string,
  receipt: Readonly<Record<string, unknown>> = replayReceiptFixture()
): Promise<void> {
  const rtkPath = path.join(binDir, "rtk");
  await writeFile(rtkPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "shift",
    "if [[ \"${1:-}\" == *prove-cache-only-replay.mjs ]]; then",
    "  out=${2:?request manifest output}",
    "  printf '%s\\n' '{\"schema_version\":1,\"kind\":\"provider_preflight_replay_request\"}' > \"$out\"",
    "  exit 0",
    "fi",
    "if [[ \"${1:-}\" == *alaya-bench-runner.mjs && \"${2:-}\" == provider-preflight ]]; then",
    "  [[ \" $* \" == *' --request-manifest '* ]] || { echo 'missing complete request manifest' >&2; exit 2; }",
    "  if [[ \" $* \" == *' --mode validate-replay-receipt '* ]]; then",
    "    receipt='' request=''",
    "    while [[ $# -gt 0 ]]; do",
    "      case \"$1\" in --receipt) receipt=$2; shift 2 ;; --request-manifest) request=$2; shift 2 ;; *) shift ;; esac",
    "    done",
    "    python3 - \"$receipt\" \"$request\" <<'PY'",
    "import json, sys",
    `expected = ${JSON.stringify(JSON.stringify(replayReceiptFixture()))}`,
    "receipt = json.loads(open(sys.argv[1], encoding='utf-8').read())",
    "request = json.loads(open(sys.argv[2], encoding='utf-8').read())",
    "assert receipt == json.loads(expected)",
    "assert request == {'schema_version': 1, 'kind': 'provider_preflight_replay_request'}",
    "PY",
    "    exit 0",
    "  fi",
    "  [[ -z \"${ALAYA_OFFICIAL_GARDEN_SECRET_REF:-}${ALAYA_OFFICIAL_GARDEN_API_KEY:-}${OFFICIAL_API_GARDEN_API_KEY:-}${ALAYA_QA_API_KEY:-}${ALAYA_GARDEN_OPENAI_SECRET_REF:-}${ALAYA_CONFLICT_LLM_PROVIDER_URL:-}${ALAYA_CONFLICT_LLM_API_KEY:-}\" ]] || { echo 'provider credentials reached replay' >&2; exit 2; }",
    "  [[ \"${ALAYA_BENCH_ALLOW_LIVE_EXTRACTION:-}\" == 0 ]] || { echo 'live extraction reached replay' >&2; exit 2; }",
    `  echo '${JSON.stringify(receipt)}'`,
    "  exit 0",
    "fi",
    "echo 'unexpected rtk invocation' >&2",
    "exit 2",
    ""
  ].join("\n"), "utf8");
  await chmod(rtkPath, 0o755);
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
    evidence_prompt_sha256:
      "3ccba91b3cfc4cee74edfee4672b880d870f320fb94124bad9c1ffb8ce60ef3a",
    query_prompt_sha256:
      "eeb420decb4cb05958f4fe5d3bcd73dfdff37d88dce0ac364cc628e0d46d2074",
    evidence_request_template_sha256:
      "67de86ee33c7315698963950647eef568c1ee864bb2508775009632c6e96d396",
    query_request_template_sha256:
      "649ea5aca1bcfc427433e708afe5428d44f070ab315deed1a9f614177de7db00"
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
    schema_version: 2,
    kind: "diagnostic_loop_checkpoint",
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
  } as const;
  const checkpoint_digest = createHash("sha256")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  await writeFile(
    path.join(dir, `${phase}.json`),
    `${JSON.stringify({ ...body, checkpoint_digest })}\n`,
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

async function writeFakeRtk(
  binDir: string,
  argvCapture: string,
  envCapture: string
): Promise<void> {
  const rtkPath = path.join(binDir, "rtk");
  await writeFile(rtkPath, fakeRtkScript(argvCapture, envCapture), "utf8");
  await chmod(rtkPath, 0o755);
}

function fakeRtkScript(argvCapture: string, envCapture: string): string {
  return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"${2:-}\" == *alaya-bench-runner.mjs && \" $* \" == *' --mode validate-recall-checkpoints '* ]]; then",
      "  exec \"$1\" \"${@:2}\"",
      "fi",
      "if [[ \"${2:-}\" == *prove-cache-only-replay.mjs ]]; then",
      "  python3 - \"${3}\" " + JSON.stringify(DIGEST) + " <<'PY'",
      "import hashlib, json, sys",
      "key = sys.argv[2]",
      "payload = {",
      "    'schema_version': 1,",
      "    'kind': 'provider_preflight_replay_request',",
      "    'request': {",
      "        'requestedKeys': [key],",
      "        'schemaDigest': key,",
      "        'operatorDigest': key,",
      "    },",
      "    'canonical_keys': {",
      "        'count': 1,",
      "        'key_set_sha256': hashlib.sha256(key.encode('utf-8')).hexdigest(),",
      "    },",
      "}",
      "open(sys.argv[1], 'w', encoding='utf-8').write(json.dumps(payload) + '\\n')",
      "PY",
      "  exit 0",
      "fi",
      `python3 - ${JSON.stringify(argvCapture)} ${JSON.stringify(envCapture)} "$@" <<'PY'`,
      "import json, os, sys",
      "open(sys.argv[1], 'w', encoding='utf-8').write(json.dumps(sys.argv[3:]) + '\\n')",
      `keys = ${JSON.stringify(CREDENTIAL_ENV_KEYS)}`,
      "payload = {",
      "    'credentials': {key: bool(os.environ.get(key)) for key in keys},",
      "    'ALAYA_BENCH_ALLOW_LIVE_EXTRACTION': os.environ.get('ALAYA_BENCH_ALLOW_LIVE_EXTRACTION'),",
      "    'ALAYA_GARDEN_PROVIDER_KIND': os.environ.get('ALAYA_GARDEN_PROVIDER_KIND'),",
      "}",
      "open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps(payload) + '\\n')",
      "PY",
      ""
  ].join("\n");
}

function isolatedChildEnv(envFile: string, binDir: string): NodeJS.ProcessEnv {
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
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ALAYA_RECALL_ANY5_ENV: envFile
  };
}
