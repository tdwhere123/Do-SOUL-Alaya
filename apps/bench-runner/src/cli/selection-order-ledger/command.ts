import process from "node:process";
import {
  CAPTURED_SCORE_FIDELITY_ASSERT,
  CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
  type CapturedScoreFidelityMode
} from "@do-soul/alaya-core";
import { materializeSelectionOrderLedgerArtifact } from
  "../../longmemeval/selection-replay/selection-order-ledger-artifact.js";

export async function runSelectionOrderLedgerCommand(
  args: readonly string[]
): Promise<number> {
  try {
    const values = parseArgs(args);
    const result = await materializeSelectionOrderLedgerArtifact({
      sourcePath: required(values, "--selection-boundaries"),
      expectedSourceSha256: required(
        values,
        "--selection-boundaries-sha256"
      ),
      outputPath: required(values, "--output"),
      checkoutRoot: process.cwd(),
      capturedScoreFidelity: parseCapturedScoreFidelity(
        values.get("--captured-score-fidelity")
      ),
      ...(values.get("--gold-map") === undefined
        ? {}
        : { goldMapPath: values.get("--gold-map") })
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`alaya-bench-runner selection-order-ledger: ${message}\n`);
    return 2;
  }
}

function parseArgs(args: readonly string[]): ReadonlyMap<string, string> {
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
  const allowed = new Set([
    "--selection-boundaries",
    "--selection-boundaries-sha256",
    "--output",
    "--captured-score-fidelity",
    "--gold-map"
  ]);
  if ([...values.keys()].some((flag) => !allowed.has(flag))) {
    throw new Error("unknown selection order ledger flag");
  }
  return values;
}

function parseCapturedScoreFidelity(
  raw: string | undefined
): CapturedScoreFidelityMode {
  if (raw === undefined || raw === "assert") {
    return CAPTURED_SCORE_FIDELITY_ASSERT;
  }
  if (raw === "recompute-live") return CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE;
  throw new Error(
    "--captured-score-fidelity must be assert or recompute-live"
  );
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} <value> required`);
  }
  return value;
}
