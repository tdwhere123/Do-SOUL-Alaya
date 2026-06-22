// Classify a UNIQUE collision by the driver's structured extended code first,
// falling back to the message text and walking the cause chain — a message-only
// match silently breaks if better-sqlite3 reworks its error text.
export function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const codeValue = (current as { readonly code?: unknown }).code;
    if (codeValue === "SQLITE_CONSTRAINT_UNIQUE") {
      return true;
    }
    const errnoValue = (current as { readonly errno?: unknown }).errno;
    if (errnoValue === 19) {
      return true;
    }
    const messageValue = (current as { readonly message?: unknown }).message;
    if (typeof messageValue === "string" && messageValue.includes("UNIQUE constraint failed")) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
