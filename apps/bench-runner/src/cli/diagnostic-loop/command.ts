import process from "node:process";
import {
  createProductionDiagnosticLoopAdapters,
  renderDiagnosticLoopFailure,
  runDiagnosticLoop,
  type DiagnosticLoopAdapters,
  type DiagnosticLoopRunResult
} from "../../bench/diagnostic-loop/index.js";
import { DiagnosticLoopFailure } from "../../bench/diagnostic-loop/failures.js";
import { parseDiagnosticLoopArgs } from "./args.js";
import { verifyCanonicalReplayRequestManifest } from
  "../provider-preflight/replay-request-manifest.js";

export interface DiagnosticLoopCommandDependencies {
  readonly run?: typeof runDiagnosticLoop;
  readonly adapters?: DiagnosticLoopAdapters;
}

export async function runDiagnosticLoopCommand(
  args: ReadonlyArray<string>,
  deps: DiagnosticLoopCommandDependencies = {}
): Promise<number> {
  try {
    const parsed = parseDiagnosticLoopArgs(args);
    if (parsed.requestManifestPath !== undefined) {
      await verifyCanonicalReplayRequestManifest(parsed.requestManifestPath);
    } else if (deps.run === undefined && deps.adapters === undefined) {
      throw new Error("diagnostic-loop requires --request-manifest");
    }
    const run = deps.run ?? runDiagnosticLoop;
    const result = await run({
      workRoot: parsed.workRoot,
      request: parsed.request,
      mode: parsed.mode,
      ...(parsed.fromPhase === undefined ? {} : { fromPhase: parsed.fromPhase }),
      ...(parsed.canaryUnlockPath === undefined ? {} : {
        canaryUnlockPath: parsed.canaryUnlockPath
      }),
      adapters: deps.adapters ?? createProductionDiagnosticLoopAdapters(),
      argv: args
    });
    process.stdout.write(renderSuccess(parsed.workRoot, parsed.mode, result));
    return 0;
  } catch (error) {
    return handleError(error);
  }
}

function renderSuccess(
  workRoot: string,
  mode: string,
  result: DiagnosticLoopRunResult
): string {
  return `Done. diagnostic-loop mode=${mode} work_root=${workRoot}\n` +
    `  identity=${result.identityDigest}\n` +
    `  completed=${result.completedPhases.join(",") || "none"}\n` +
    `  skipped=${result.skippedPhases.join(",") || "none"}\n` +
    `  phases_skipped=${result.avoidedWork.phasesSkipped} ` +
    `provider_calls_avoided=${result.avoidedWork.providerCallsAvoided} ` +
    `questions_skipped=${result.avoidedWork.questionsSkipped} ` +
    `snapshots_reused=${result.avoidedWork.snapshotsReused}\n` +
    `  smoke_gate=${result.smokeGate}\n` +
    `  report=${result.reportPath}\n`;
}

function handleError(error: unknown): number {
  if (error instanceof DiagnosticLoopFailure) {
    process.stderr.write(renderDiagnosticLoopFailure(error));
    return 2;
  }
  process.stderr.write(
    `alaya-bench-runner diagnostic-loop: ${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
  return 2;
}
