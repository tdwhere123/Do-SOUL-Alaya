// SQLITE_CONSTRAINT / errno 19 also cover CHECK / NOT NULL / FOREIGN KEY.
// Only SQLITE_CONSTRAINT_UNIQUE (or the UNIQUE constraint failed message) counts.
// qualifiedColumn narrows to one index when provided.
export function isUniqueConstraintError(error: unknown, qualifiedColumn?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const codeValue = (current as { readonly code?: unknown }).code;
    const messageValue = (current as { readonly message?: unknown }).message;
    const uniqueCode = codeValue === "SQLITE_CONSTRAINT_UNIQUE";
    const uniqueMessage =
      typeof messageValue === "string" && messageValue.includes("UNIQUE constraint failed");
    const matchesColumn =
      qualifiedColumn === undefined ||
      (typeof messageValue === "string" && messageValue.includes(qualifiedColumn));
    if ((uniqueCode || uniqueMessage) && matchesColumn) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
