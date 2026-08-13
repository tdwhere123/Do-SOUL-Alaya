import process from "node:process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishExclusiveOutput } from "../output/exclusive-output.js";
import { runCaptureParity } from
  "../../longmemeval/capture-parity/run.js";
import type { LongMemEvalVariant } from
  "../../longmemeval/ingestion/dataset.js";
import type { BenchPolicyShape } from "@do-soul/alaya-eval";

export async function runCaptureParityCommand(
  args: readonly string[]
): Promise<number> {
  try {
    const options = await parseCaptureParityOptions(args);
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
    return report.parity ? 0 : 1;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`alaya-bench-runner capture-parity: ${message}\n`);
    return 2;
  }
}

async function parseCaptureParityOptions(args: readonly string[]): Promise<{
  readonly snapshotDbPath: string;
  readonly outputPath: string;
  readonly variant: LongMemEvalVariant;
  readonly historyRoot: string;
  readonly dataDirRoot: string;
  readonly policyShape?: BenchPolicyShape;
  readonly querySemanticFactorCachePath?: string;
}> {
  const values = parseFlagPairs(args);
  const snapshotDbPath = required(values, "--snapshot");
  const outputPath = required(values, "--output");
  const variant = optionalVariant(values.get("--variant"));
  const policyShape = optionalPolicyShape(values.get("--policy-shape"));
  const dataDirRoot = values.get("--data-dir-root") ??
    await mkdtemp(join(tmpdir(), "alaya-capture-parity-"));
  const historyRoot = values.get("--history-root") ?? join(dataDirRoot, "history");
  return {
    snapshotDbPath,
    outputPath,
    variant,
    dataDirRoot,
    historyRoot,
    ...(policyShape === undefined ? {} : { policyShape }),
    ...(values.get("--query-semantic-factor-cache") === undefined
      ? {}
      : { querySemanticFactorCachePath: values.get("--query-semantic-factor-cache") })
  };
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
