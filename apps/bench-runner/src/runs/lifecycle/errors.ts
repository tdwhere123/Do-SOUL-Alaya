export function throwLifecycleErrors(
  message: string,
  errors: readonly (unknown | undefined)[]
): void {
  const present = errors
    .filter((error) => error !== undefined)
    .filter((error, index, all) => all.indexOf(error) === index);
  if (present.length === 0) return;
  if (present.length === 1) throw present[0];
  throw new AggregateError(present, message, { cause: present[0] });
}

export interface BoundedLifecycleFailure {
  readonly phase: string;
  readonly name: string;
  readonly code: string | null;
}

export function boundLifecycleFailure(
  phase: string,
  error: unknown
): BoundedLifecycleFailure {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return Object.freeze({
    phase: safeDiagnosticToken(phase, "unknown"),
    name: safeDiagnosticToken(name, "Error"),
    code: typeof code === "string" ? safeDiagnosticToken(code, "UNKNOWN") : null
  });
}

export function renderLifecycleFailure(failure: BoundedLifecycleFailure): string {
  return `phase=${failure.phase} name=${failure.name} code=${failure.code ?? "none"}`;
}

function safeDiagnosticToken(value: string, fallback: string): string {
  const bounded = value.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 64);
  return bounded.length === 0 ? fallback : bounded;
}
