import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import { StorageError } from "../../../../shared/errors.js";

const transactionScope = new AsyncLocalStorage<{ open: boolean }>();

/** A rejected callback's asynchronous descendants must not escape into standalone writes. */
export function assertEventLogWriteScope(): void {
  if (transactionScope.getStore()?.open === false) {
    throw new StorageError("VALIDATION_FAILED", "EventLog transaction callbacks must not continue asynchronously.");
  }
}

export function runSynchronousEventLogTransaction<T>(
  connection: StorageDatabase["connection"], fn: () => T
): T {
  assertEventLogWriteScope();
  if (types.isAsyncFunction(fn)) {
    throw new StorageError("VALIDATION_FAILED", "EventLog transaction callbacks must be synchronous.");
  }
  const scope = { open: true };
  return transactionScope.run(scope, () => {
    try {
      return connection.transaction(() => {
        const value = fn();
        if (value !== null && (typeof value === "object" || typeof value === "function") &&
            "then" in value && typeof value.then === "function") {
          // The caller receives the synchronous contract error. Observe a returned
          // promise's rejection too; its descendants retain the closed write scope.
          void Promise.resolve(value).catch(() => undefined);
          throw new StorageError("VALIDATION_FAILED", "EventLog transaction callbacks must not return a Promise.");
        }
        return value;
      }).immediate();
    } finally {
      scope.open = false;
    }
  });
}
