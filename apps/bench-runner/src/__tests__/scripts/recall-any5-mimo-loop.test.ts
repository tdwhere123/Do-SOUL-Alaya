import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/recall-any5-mimo-loop.sh"
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

interface OperatorLoopHarness {
  readonly snapshot: string;
  readonly workRoot: string;
  readonly argvCapture: string;
  readonly envCapture: string;
  readonly env: NodeJS.ProcessEnv;
}

interface CapturedLoopEnv {
  readonly credentials: Record<(typeof CREDENTIAL_ENV_KEYS)[number], boolean>;
  readonly ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: string | null;
}

describe("recall-any5-mimo-loop", () => {
  it("refuses a window larger than 3 without an explicit confirm", async () => {
    await chmod(script, 0o755);
    await expect(execFileAsync("bash", [script, "diagnostic", "--limit", "100"], {
      timeout: 10_000
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("refusing limit=100")
    });
  });

  describe("diagnostic snapshot reuse", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), "recall-any5-mimo-loop-"));
      await chmod(script, 0o755);
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("passes --snapshot to diagnostic-loop and omits --snapshot-out", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      const argv = await invokeDiagnosticLoop(harness, [
        "--limit",
        "1",
        "--snapshot",
        harness.snapshot,
        "--work-root",
        harness.workRoot
      ]);
      expect(flagValue(argv, "--snapshot")).toBe(harness.snapshot);
      expect(argv).not.toContain("--snapshot-out");
      await expectCacheOnlyLoopEnv(harness, argv);
    });

    it("keeps default diagnostic on --snapshot-out when reuse is not selected", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      const argv = await invokeDiagnosticLoop(harness, [
        "--limit",
        "1",
        "--work-root",
        harness.workRoot
      ]);
      expect(argv).not.toContain("--snapshot");
      expect(flagValue(argv, "--snapshot-out")).toBe(
        path.join(harness.workRoot, "snapshot.db")
      );
      await expectCacheOnlyLoopEnv(harness, argv);
    });

    it("refuses empty --snapshot before diagnostic-loop", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      await expectRejectedBeforeLoop(harness, [
        "diagnostic",
        "--limit",
        "1",
        "--snapshot",
        "",
        "--work-root",
        harness.workRoot
      ], "snapshot");
    });

    it("refuses a missing --snapshot operand before diagnostic-loop", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      await expectRejectedBeforeLoop(harness, [
        "diagnostic",
        "--limit",
        "1",
        "--work-root",
        harness.workRoot,
        "--snapshot"
      ], "snapshot");
    });

    it("refuses --snapshot on inspect-seed rather than ignoring it", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      await expectRejectedBeforeLoop(harness, [
        "inspect-seed",
        "--snapshot",
        harness.snapshot
      ], "snapshot");
    });

    it.each([
      {
        name: "default diagnostic with completed control recall",
        phase: "control_recall" as const,
        reuse: false
      },
      {
        name: "default diagnostic with completed treatment recall",
        phase: "treatment_recall" as const,
        reuse: false
      },
      {
        name: "snapshot reuse with completed control recall",
        phase: "control_recall" as const,
        reuse: true
      },
      {
        name: "snapshot reuse with completed treatment recall",
        phase: "treatment_recall" as const,
        reuse: true
      }
    ])("refuses $name", async ({ phase, reuse }) => {
      const harness = await writeOperatorLoopHarness(tmpDir, `${phase}-${reuse ? "reuse" : "default"}`);
      await writeCompletedRecallCheckpoint(harness.workRoot, phase);
      await expectRejectedBeforeLoop(
        harness,
        diagnosticArgs(harness, reuse),
        "completed recall checkpoint"
      );
    });

    it.each([
      { name: "default diagnostic", reuse: false },
      { name: "snapshot reuse", reuse: true }
    ])("refuses $name when a recall checkpoint is truncated", async ({ reuse }) => {
      const harness = await writeOperatorLoopHarness(tmpDir, `trunc-${reuse ? "reuse" : "default"}`);
      await writeTruncatedRecallCheckpoint(harness.workRoot);
      await expectRejectedBeforeLoop(harness, diagnosticArgs(harness, reuse), "checkpoint");
    });

    it("refuses snapshot reuse when the snapshot path is not a file", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      await expectRejectedBeforeLoop(harness, [
        "diagnostic",
        "--limit",
        "1",
        "--snapshot",
        path.join(tmpDir, "absent-snapshot.db"),
        "--work-root",
        harness.workRoot
      ], "snapshot");
    });

    it.each([
      {
        name: "default diagnostic with schema-less recall checkpoint",
        reuse: false,
        workName: "schema-default-foo",
        payload: { foo: 1 }
      },
      {
        name: "snapshot reuse with schema-less recall checkpoint",
        reuse: true,
        workName: "schema-reuse-foo",
        payload: { foo: 1 }
      },
      {
        name: "default diagnostic with wrong checkpoint schema",
        reuse: false,
        workName: "schema-default-status",
        payload: {
          schema_version: 99,
          kind: "diagnostic_loop_checkpoint",
          phase: "control_recall",
          status: "failed"
        }
      }
    ])("refuses $name before diagnostic-loop", async ({ reuse, workName, payload }) => {
      const harness = await writeOperatorLoopHarness(tmpDir, workName);
      await writeParseableRecallCheckpoint(harness.workRoot, payload);
      await expectRejectedBeforeLoop(harness, diagnosticArgs(harness, reuse), "invalid");
    });

    it("refuses default diagnostic when work snapshot.db already exists", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir, "existing-work-snapshot");
      await writeFile(path.join(harness.workRoot, "snapshot.db"), "existing-work-snapshot\n");
      await expectRejectedBeforeLoop(
        harness,
        diagnosticArgs(harness, false),
        "snapshot"
      );
    });

    it("keeps snapshot reuse when work snapshot.db already exists", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir, "reuse-existing-work-snapshot");
      await writeFile(path.join(harness.workRoot, "snapshot.db"), "existing-work-snapshot\n");
      const argv = await invokeDiagnosticLoop(harness, [
        "--limit",
        "1",
        "--snapshot",
        harness.snapshot,
        "--work-root",
        harness.workRoot
      ]);
      expect(flagValue(argv, "--snapshot")).toBe(harness.snapshot);
      expect(argv).not.toContain("--snapshot-out");
    });

    it.each([
      { name: "default diagnostic", reuse: false },
      { name: "snapshot reuse", reuse: true }
    ])("forwards $name with a schema-valid failed recall checkpoint", async ({ reuse }) => {
      const harness = await writeOperatorLoopHarness(
        tmpDir,
        `failed-${reuse ? "reuse" : "default"}`
      );
      await writeParseableRecallCheckpoint(harness.workRoot, {
        schema_version: 1,
        kind: "diagnostic_loop_checkpoint",
        phase: "control_recall",
        status: "failed"
      });
      const argv = await invokeDiagnosticLoop(
        harness,
        reuse
          ? ["--limit", "1", "--snapshot", harness.snapshot, "--work-root", harness.workRoot]
          : ["--limit", "1", "--work-root", harness.workRoot]
      );
      if (reuse) {
        expect(flagValue(argv, "--snapshot")).toBe(harness.snapshot);
        expect(argv).not.toContain("--snapshot-out");
      } else {
        expect(argv).not.toContain("--snapshot");
        expect(flagValue(argv, "--snapshot-out")).toBe(
          path.join(harness.workRoot, "snapshot.db")
        );
      }
    });
  });
});

function diagnosticArgs(harness: OperatorLoopHarness, reuse: boolean): string[] {
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

async function expectRejectedBeforeLoop(
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

async function invokeDiagnosticLoop(
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

async function expectCacheOnlyLoopEnv(
  harness: OperatorLoopHarness,
  argv: readonly string[]
): Promise<void> {
  expect(flagValue(argv, "--mode")).toBe("cache-only");
  const captured = JSON.parse(await readFile(harness.envCapture, "utf8")) as CapturedLoopEnv;
  expect(captured.credentials).toEqual(ABSENT_CREDENTIALS);
  expect(captured.ALAYA_BENCH_ALLOW_LIVE_EXTRACTION).toBe("0");
}

async function writeOperatorLoopHarness(
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
    requested_key: DIGEST
  })}\n`);
  await writeFile(envFile, [
    `ALAYA_BENCH_EXTRACTION_CACHE_ROOT=${cacheRoot}`,
    "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION=1",
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
    env: isolatedChildEnv(envFile, binDir)
  };
}

async function writeFakeRtk(
  binDir: string,
  argvCapture: string,
  envCapture: string
): Promise<void> {
  const rtkPath = path.join(binDir, "rtk");
  await writeFile(
    rtkPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `python3 - ${JSON.stringify(argvCapture)} ${JSON.stringify(envCapture)} "$@" <<'PY'`,
      "import json, os, sys",
      "open(sys.argv[1], 'w', encoding='utf-8').write(json.dumps(sys.argv[3:]) + '\\n')",
      `keys = ${JSON.stringify(CREDENTIAL_ENV_KEYS)}`,
      "payload = {",
      "    'credentials': {key: bool(os.environ.get(key)) for key in keys},",
      "    'ALAYA_BENCH_ALLOW_LIVE_EXTRACTION': os.environ.get('ALAYA_BENCH_ALLOW_LIVE_EXTRACTION'),",
      "}",
      "open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps(payload) + '\\n')",
      "PY",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(rtkPath, 0o755);
}

async function writeCompletedRecallCheckpoint(
  workRoot: string,
  phase: "control_recall" | "treatment_recall" = "control_recall"
): Promise<void> {
  const dir = path.join(workRoot, "checkpoints");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${phase}.json`),
    `${JSON.stringify({
      schema_version: 1,
      kind: "diagnostic_loop_checkpoint",
      phase,
      status: "completed"
    })}\n`,
    "utf8"
  );
}

async function writeParseableRecallCheckpoint(
  workRoot: string,
  payload: unknown
): Promise<void> {
  const dir = path.join(workRoot, "checkpoints");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "control_recall.json"), `${JSON.stringify(payload)}\n`, "utf8");
}

async function writeTruncatedRecallCheckpoint(workRoot: string): Promise<void> {
  const dir = path.join(workRoot, "checkpoints");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "control_recall.json"), '{"status":"completed"', "utf8");
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

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}
