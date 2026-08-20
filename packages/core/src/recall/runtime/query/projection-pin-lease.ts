import type { ProjectionPin } from "@do-soul/alaya-protocol";
import type { RecallFieldQuerySession } from "./field-query-session.js";

const PROJECTION_PIN_LEASE_MS = 5 * 60_000;
const PROJECTION_PIN_HEARTBEAT_MS = PROJECTION_PIN_LEASE_MS / 2;

export type ProjectionPinHeartbeatScheduler = Readonly<{
  every(intervalMs: number, callback: () => void): () => void;
}>;

export type ProjectionPinLeaseGuard = Readonly<{
  assertHealthy(): void;
  stop(): void;
}>;

export function finishProjectionPinCleanup(
  steps: readonly (() => void)[],
  warn: (message: string, meta: Record<string, unknown>) => void
): void {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      failures.push(error);
    }
  }
  const warningFailures: unknown[] = [];
  for (const error of failures) {
    try {
      warn("projection pin cleanup failed", {
        operation: "projection_pin_cleanup",
        errorName: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch (warningFailure) {
      warningFailures.push(warningFailure);
    }
  }
  const allFailures = [...failures, ...warningFailures];
  if (allFailures.length > 0) {
    throw new AggregateError(allFailures, "projection pin cleanup failed");
  }
}

export function projectionPinExpiry(renewedAt: string): string {
  const renewedAtMs = projectionPinTimeMs(renewedAt);
  return new Date(renewedAtMs + PROJECTION_PIN_LEASE_MS).toISOString();
}

export function canonicalProjectionPinTime(value: string): string {
  return new Date(projectionPinTimeMs(value)).toISOString();
}

export function startProjectionPinLeaseGuard(input: Readonly<{
  readonly session: RecallFieldQuerySession;
  readonly pin: ProjectionPin;
  readonly captureOperationalTime: () => string;
  readonly scheduler?: ProjectionPinHeartbeatScheduler;
}>): ProjectionPinLeaseGuard {
  let failure: unknown = null;
  let stopped = false;
  let expiresAt = input.pin.expires_at;
  const renew = (renewedAt: string) => {
    if (stopped || failure !== null) return;
    try {
      expiresAt = input.session.renew(input.pin, renewedAt).expires_at;
    } catch (error) {
      failure = error;
    }
  };
  const renewNow = () => {
    if (stopped || failure !== null) return;
    try {
      renew(canonicalProjectionPinTime(input.captureOperationalTime()));
    } catch (error) {
      failure = error;
    }
  };
  renewNow();
  if (failure !== null) throw failure;
  const cancel = (input.scheduler ?? systemHeartbeatScheduler).every(
    PROJECTION_PIN_HEARTBEAT_MS,
    renewNow
  );
  return Object.freeze({
    assertHealthy() {
      if (failure !== null) throw failure;
      let operationalTime: string;
      try {
        operationalTime = canonicalProjectionPinTime(input.captureOperationalTime());
      } catch (error) {
        failure = error;
        throw error;
      }
      if (renewalIsDue(expiresAt, operationalTime)) renew(operationalTime);
      if (failure !== null) throw failure;
    },
    stop() {
      if (stopped) return;
      try {
        cancelHeartbeat(cancel);
      } finally {
        // A failed scheduler must not keep extending a pin after recall termination.
        stopped = true;
      }
    }
  });
}

function cancelHeartbeat(cancel: () => void): void {
  try {
    cancel();
  } catch (firstFailure) {
    try {
      cancel();
    } catch (secondFailure) {
      throw new AggregateError(
        [firstFailure, secondFailure],
        "projection pin heartbeat cancellation failed"
      );
    }
  }
}

function renewalIsDue(expiresAt: string, operationalTime: string): boolean {
  return projectionPinTimeMs(expiresAt) - projectionPinTimeMs(operationalTime) <=
    PROJECTION_PIN_HEARTBEAT_MS;
}

function projectionPinTimeMs(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("projection pin time must be a valid date-time");
  }
  return milliseconds;
}

const systemHeartbeatScheduler: ProjectionPinHeartbeatScheduler = Object.freeze({
  every(intervalMs, callback) {
    // In-flight recall must keep the event loop alive.
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }
});
