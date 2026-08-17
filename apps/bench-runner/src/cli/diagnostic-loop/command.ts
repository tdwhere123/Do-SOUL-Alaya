import process from "node:process";
import {
  createProductionDiagnosticLoopAdapters,
  renderDiagnosticLoopFailure,
  runDiagnosticLoop,
  type DiagnosticLoopAdapters,
  type DiagnosticLoopRunResult
} from "../../longmemeval/diagnostic-loop/index.js";
import { DiagnosticLoopFailure } from "../../longmemeval/diagnostic-loop/failures.js";
import { parseDiagnosticLoopArgs } from "./args.js";

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
    const run = deps.run ?? runDiagnosticLoop;
    const result = await run({
      workRoot: parsed.workRoot,
      request: parsed.request,
      mode: parsed.mode,
      ...(parsed.fromPhase === undefined ? {} : { fromPhase: parsed.fromPhase }),
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
