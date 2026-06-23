// invariant: surfaces only UNEXPECTED recall auxiliary failures to the operator
// health inbox (sibling of path-failure-health-inbox.ts). Known graceful
// degradations stay warn-only. Best-effort: the wrapper swallows its throw.
export interface RecallFailureHealthInboxEntry {
  readonly workspaceId: string;
  // failed recall operation; deduped per workspace as target_object_id.
  readonly operation: string;
  readonly observedAt: string;
}

export interface RecallFailureHealthInboxPort {
  recordRecallFailure(entry: RecallFailureHealthInboxEntry): Promise<void> | void;
}

// JS programming-error classes; everything else (CoreError, AbortError, provider
// errors) is treated as expected degradation and stays warn-only.
const UNEXPECTED_RECALL_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError"
]);

function isUnexpectedRecallErrorName(errorName: string | undefined): boolean {
  return errorName !== undefined && UNEXPECTED_RECALL_ERROR_NAMES.has(errorName);
}

// Wraps the base recall warn so any warn carrying an unexpected `errorName` also
// lands an aggregated health-inbox entry. Sites opt in by adding `operation` +
// `errorName` to their warn meta; warns without them only log.
export function wrapRecallFaultWarn(
  baseWarn: (message: string, meta: Record<string, unknown>) => void,
  healthInbox: RecallFailureHealthInboxPort | undefined,
  workspaceId: string,
  now: () => string
): (message: string, meta: Record<string, unknown>) => void {
  if (healthInbox === undefined) {
    return baseWarn;
  }
  return (message, meta) => {
    baseWarn(message, meta);
    const errorName = typeof meta.errorName === "string" ? meta.errorName : undefined;
    if (!isUnexpectedRecallErrorName(errorName)) {
      return;
    }
    const operation = typeof meta.operation === "string" ? meta.operation : message;
    void recordRecallFailureBestEffort(healthInbox, {
      workspaceId,
      operation,
      observedAt: now()
    });
  };
}

async function recordRecallFailureBestEffort(
  healthInbox: RecallFailureHealthInboxPort,
  entry: RecallFailureHealthInboxEntry
): Promise<void> {
  try {
    await healthInbox.recordRecallFailure(entry);
  } catch (error) {
    // best-effort projection; never break recall, but surface the swallow.
    process.emitWarning("[RecallFailureHealthInbox] recall-failure health-inbox write failed", {
      code: "ALAYA_RECALL_FAILURE_INBOX_WRITE_FAILED",
      detail: JSON.stringify({
        workspace_id: entry.workspaceId,
        operation: entry.operation,
        error: error instanceof Error ? error.message : String(error)
      })
    });
  }
}
