import process from "node:process";
import { join } from "node:path";
import { publishExclusiveOutput } from "../output/exclusive-output.js";
import { runCaptureParity } from
  "../../longmemeval/capture-parity/run.js";
import type { LongMemEvalVariant } from
  "../../longmemeval/ingestion/dataset.js";
import type { BenchPolicyShape } from "@do-soul/alaya-eval";
import {
  createOwnedTempRoot,
  externalTempRoot,
  finalizeOwnedTempRoot,
  type OwnedTempRoot
} from "../../longmemeval/lifecycle/owned-temp-root.js";

export async function runCaptureParityCommand(
  args: readonly string[]
): Promise<number> {
  let scratchRoot: OwnedTempRoot | undefined;
  let exitCode = 2;
  try {
    const parsed = await parseCaptureParityOptions(args);
    const { options } = parsed;
    scratchRoot = parsed.scratchRoot;
    const report = await runCaptureParity(options);
    await publishExclusiveOutput(
      options.outputPath,
      `${JSON.stringify(report, null, 2)}\n`
    );
    process.stdout.write(`${JSON.stringify({
      parity: report.parity,
      question_count: report.question_count,
      sidecar_question_count: report.sidecar_question_count,
      window_length: report.window_length,
      geometry_basis: report.geometry_basis,
      channels: report.summary.channels,
      geometry: report.summary.geometry,
      membership: report.summary.membership,
      exercised_masks: report.summary.exercised_masks,
      first_difference: report.first_difference,
      output: options.outputPath
    })}\n`);
    exitCode = report.parity ? 0 : 1;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`alaya-bench-runner capture-parity: ${message}\n`);
  } finally {
    let cleanupError: unknown;
    try {
      if (scratchRoot !== undefined) {
        await finalizeOwnedTempRoot(scratchRoot, true);
      }
    } catch (cause) {
      cleanupError = cause;
    }
    if (cleanupError !== undefined) {
      const message = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
      process.stderr.write(`alaya-bench-runner capture-parity cleanup: ${message}\n`);
      exitCode = 2;
    }
  }
  return exitCode;
}

async function parseCaptureParityOptions(args: readonly string[]): Promise<{
  readonly options: {
  readonly snapshotDbPath: string;
  readonly outputPath: string;
  readonly variant: LongMemEvalVariant;
  readonly historyRoot: string;
  readonly dataDirRoot: string;
  readonly policyShape?: BenchPolicyShape;
  readonly querySemanticFactorCachePath?: string;
  };
  readonly scratchRoot: OwnedTempRoot;
}> {
  const values = parseFlagPairs(args);
  const snapshotDbPath = required(values, "--snapshot");
  const outputPath = required(values, "--output");
  const variant = optionalVariant(values.get("--variant"));
  const policyShape = optionalPolicyShape(values.get("--policy-shape"));
  const suppliedDataRoot = values.get("--data-dir-root");
  const scratchRoot = suppliedDataRoot === undefined
    ? await createOwnedTempRoot("alaya-capture-parity-")
    : externalTempRoot(suppliedDataRoot);
  const dataDirRoot = scratchRoot.path;
  const historyRoot = values.get("--history-root") ?? join(dataDirRoot, "history");
  return { options: {
    snapshotDbPath,
    outputPath,
    variant,
    dataDirRoot,
    historyRoot,
    ...(policyShape === undefined ? {} : { policyShape }),
    ...(values.get("--query-semantic-factor-cache") === undefined
      ? {}
      : { querySemanticFactorCachePath: values.get("--query-semantic-factor-cache") })
  }, scratchRoot };
}

function parseFlagPairs(args: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") ||
        value.startsWith("--") || values.has(flag)) {
      throw new Error("expected unique --flag value pairs");
    }
    values.set(flag, value);
  }
  if (values.has("--limit") || values.has("--offset")) {
    throw new Error("capture-parity refuses --limit and --offset");
  }
  const allowed = new Set([
    "--snapshot",
    "--output",
    "--query-semantic-factor-cache",
    "--data-dir-root",
    "--history-root",
    "--variant",
    "--policy-shape"
  ]);
  if ([...values.keys()].some((flag) => !allowed.has(flag))) {
    throw new Error("unknown capture-parity flag");
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} <value> required`);
  }
  return value;
}

function optionalVariant(raw: string | undefined): LongMemEvalVariant {
  if (raw === undefined || raw === "s" || raw === "longmemeval_s") {
    return "longmemeval_s";
  }
  if (raw === "oracle" || raw === "longmemeval_oracle") return "longmemeval_oracle";
  if (raw === "m" || raw === "longmemeval_m") return "longmemeval_m";
  throw new Error("--variant must be oracle, s, or m");
}

function optionalPolicyShape(raw: string | undefined): BenchPolicyShape | undefined {
  if (raw === undefined) return undefined;
  if (raw === "stress" || raw === "chat") return raw;
  throw new Error("--policy-shape must be stress or chat");
}
