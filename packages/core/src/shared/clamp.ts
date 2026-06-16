// Non-finite input collapses to 0 so a stray NaN/Infinity cannot poison score
// comparisons downstream.
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
