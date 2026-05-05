export function isUniqueConstraintError(error: unknown): boolean {
  const message = String((error as { cause?: { message?: string } })?.cause?.message ?? "");
  return message.includes("UNIQUE constraint failed");
}
