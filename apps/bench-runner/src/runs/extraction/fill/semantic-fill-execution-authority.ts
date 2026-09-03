import type {
  SemanticFillAttempt,
  SemanticFillTask
} from "./semantic-fill-executor.js";

export interface VerifiedSemanticFillExecution {
  readonly kind: "verified-semantic-fill-execution";
}

export interface CapturedSemanticFillExecution {
  readonly tasks: readonly SemanticFillTask[];
  readonly attempts: readonly SemanticFillAttempt[];
  readonly uniqueUnits: number;
  readonly occurrenceCount: number;
  readonly bindingCount: number;
  readonly calls: number;
  readonly failures: number;
  readonly ledgerScopeIdentity: string;
  readonly startingCacheIdentity: string;
  readonly startingOverlayIdentity: string;
}

const verifiedExecutions = new WeakMap<object, CapturedSemanticFillExecution>();

export function sealVerifiedSemanticFillExecution(
  captured: CapturedSemanticFillExecution
): VerifiedSemanticFillExecution {
  const handle = Object.freeze({ kind: "verified-semantic-fill-execution" as const });
  verifiedExecutions.set(handle, Object.freeze(captured));
  return handle;
}

export function unwrapVerifiedSemanticFillExecution(
  handle: VerifiedSemanticFillExecution
): CapturedSemanticFillExecution {
  const captured = verifiedExecutions.get(handle);
  if (captured === undefined) throw new Error("lazy receipt requires verified fill execution");
  return captured;
}
