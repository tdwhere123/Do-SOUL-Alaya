export function exitCodeForVerdicts(
  verdictPerKpi: Record<string, string> | undefined
): number {
  if (verdictPerKpi === undefined) return 0;
  const values = Object.values(verdictPerKpi);
  if (values.includes("fail")) return 1;
  return 0;
}

export function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
