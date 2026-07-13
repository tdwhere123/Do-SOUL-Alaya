export class GardenTaskClaimCasMiss extends Error {
  constructor() {
    super("Garden task already claimed by another worker.");
    this.name = "GardenTaskClaimCasMiss";
  }
}

export class GardenTaskPendingFailureCasMiss extends Error {
  constructor() {
    super("Garden task is no longer pending.");
    this.name = "GardenTaskPendingFailureCasMiss";
  }
}

export function isUniqueConstraintError(error: unknown, qualifiedColumn: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const codeValue = (current as { readonly code?: unknown }).code;
    const messageValue = (current as { readonly message?: unknown }).message;
    const isUniqueCode =
      typeof codeValue === "string" && codeValue.startsWith("SQLITE_CONSTRAINT");
    const matchesColumn =
      typeof messageValue === "string" && messageValue.includes(qualifiedColumn);
    if (isUniqueCode && matchesColumn) {
      return true;
    }
    if (matchesColumn && typeof messageValue === "string" && messageValue.includes("UNIQUE")) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
