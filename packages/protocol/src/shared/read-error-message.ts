// Narrow an unknown thrown value to its message, with a caller-supplied fallback for non-Error throws.
export function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
