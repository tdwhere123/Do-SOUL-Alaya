export function emitBenchHarnessWarning(
  code: string,
  operation: string,
  error: unknown,
  extra: Record<string, unknown> = {}
): void {
  process.emitWarning("[BenchDaemon] best-effort operation failed", {
    code,
    detail: JSON.stringify({
      operation,
      error: error instanceof Error ? error.message : String(error),
      ...extra
    })
  });
}
