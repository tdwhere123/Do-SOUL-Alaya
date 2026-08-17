import { boundLifecycleFailure } from "../lifecycle/errors.js";
import type { DiagnosticLoopMode, DiagnosticLoopPhase } from "./phases.js";
import type {
  DiagnosticLoopFailureClass,
  DiagnosticLoopRequest
} from "./types.js";

export class DiagnosticLoopFailure extends Error {
  readonly phase: DiagnosticLoopPhase;
  readonly classification: DiagnosticLoopFailureClass;
  readonly resumeCommand: string;

  constructor(input: {
    readonly phase: DiagnosticLoopPhase;
    readonly classification: DiagnosticLoopFailureClass;
    readonly message: string;
    readonly resumeCommand: string;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "DiagnosticLoopFailure";
    this.phase = input.phase;
    this.classification = input.classification;
    this.resumeCommand = input.resumeCommand;
  }
}

export function defaultFailureClass(phase: DiagnosticLoopPhase): DiagnosticLoopFailureClass {
  if (phase === "authority_cache" || phase === "extraction") return "authority";
  if (phase === "control_recall" || phase === "treatment_recall") return "candidate";
  if (phase === "miss_ledger") return "selection";
  return "infrastructure";
}

export function renderResumeCommand(input: {
  readonly workRoot: string;
  readonly phase: DiagnosticLoopPhase;
  readonly mode: DiagnosticLoopMode;
  readonly argv: readonly string[];
}): string {
  const preserved = stripResumeFlags(input.argv);
  const suffix = preserved.length === 0 ? "" : ` ${preserved.join(" ")}`;
  return `alaya-bench-runner diagnostic-loop --work-root ${input.workRoot} ` +
    `--from-phase ${input.phase} --mode ${input.mode}${suffix}`;
}

export function renderDiagnosticLoopFailure(error: DiagnosticLoopFailure): string {
  const bounded = boundLifecycleFailure(error.phase, error);
  return `alaya-bench-runner diagnostic-loop: phase=${error.phase} ` +
    `class=${error.classification} name=${bounded.name} ` +
    `code=${bounded.code ?? "none"}\n${error.message}\n` +
    `resume: ${error.resumeCommand}\n`;
}

export function wrapPhaseError(input: {
  readonly phase: DiagnosticLoopPhase;
  readonly mode: DiagnosticLoopMode;
  readonly workRoot: string;
  readonly argv: readonly string[];
  readonly request: DiagnosticLoopRequest;
  readonly error: unknown;
}): DiagnosticLoopFailure {
  const resumeCommand = renderResumeCommand({
    workRoot: input.workRoot,
    phase: input.error instanceof DiagnosticLoopFailure ? input.error.phase : input.phase,
    mode: input.mode,
    argv: input.argv
  });
  if (input.error instanceof DiagnosticLoopFailure) {
    return new DiagnosticLoopFailure({
      phase: input.error.phase,
      classification: input.error.classification,
      message: input.error.message,
      resumeCommand,
      cause: input.error
    });
  }
  return new DiagnosticLoopFailure({
    phase: input.phase,
    classification: defaultFailureClass(input.phase),
    message: input.error instanceof Error ? input.error.message : String(input.error),
    resumeCommand,
    cause: input.error
  });
}

function stripResumeFlags(argv: readonly string[]): readonly string[] {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--from-phase" || token === "--work-root" || token === "--mode") {
      if (!token.includes("=")) index += 1;
      continue;
    }
    if (
      token.startsWith("--from-phase=") ||
      token.startsWith("--work-root=") ||
      token.startsWith("--mode=")
    ) {
      continue;
    }
    stripped.push(token);
  }
  return stripped;
}
