import type { SqliteWriteJobKind, SqliteWriteStatement } from "./port.js";

export type SqliteWriteQueueWorkerRequest =
  | {
      readonly type: "run";
      readonly requestId: number;
      readonly jobId: string;
      readonly kind: SqliteWriteJobKind;
      readonly filename: string;
      readonly statements: readonly SqliteWriteStatement[];
    }
  | {
      readonly type: "shutdown";
      readonly requestId: number;
    };

export type SqliteWriteQueueWorkerResponse =
  | {
      readonly type: "ready";
    }
  | {
      readonly type: "result";
      readonly requestId: number;
      readonly ok: true;
    }
  | {
      readonly type: "result";
      readonly requestId: number;
      readonly ok: false;
      readonly error: string;
    };

export function isSqliteWriteQueueWorkerResponse(
  value: unknown
): value is SqliteWriteQueueWorkerResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { readonly type?: unknown; readonly requestId?: unknown; readonly ok?: unknown };
  if (record.type === "ready") {
    return true;
  }
  if (record.type !== "result" || typeof record.requestId !== "number" || typeof record.ok !== "boolean") {
    return false;
  }
  return true;
}
