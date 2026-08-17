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

export function projectionPinExpiry(renewedAt: string): string {
  const renewedAtMs = Date.parse(renewedAt);
  if (!Number.isFinite(renewedAtMs)) {
    throw new Error("projection pin renewal time must be a valid date-time");
  }
  return new Date(renewedAtMs + PROJECTION_PIN_LEASE_MS).toISOString();
}

export function startProjectionPinLeaseGuard(input: Readonly<{
  readonly session: RecallFieldQuerySession;
  readonly pin: ProjectionPin;
  readonly captureOperationalTime: () => string;
  readonly scheduler?: ProjectionPinHeartbeatScheduler;
}>): ProjectionPinLeaseGuard {
  let failure: unknown = null;
  let stopped = false;
  const renew = () => {
    if (stopped || failure !== null) return;
    try {
      input.session.renew(input.pin, input.captureOperationalTime());
    } catch (error) {
      failure = error;
    }
  };
  renew();
  const cancel = (input.scheduler ?? systemHeartbeatScheduler).every(
    PROJECTION_PIN_HEARTBEAT_MS,
    renew
  );
  return Object.freeze({
    assertHealthy() {
      if (failure !== null) throw failure;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancel();
      if (failure !== null) throw failure;
    }
  });
}

const systemHeartbeatScheduler: ProjectionPinHeartbeatScheduler = Object.freeze({
  every(intervalMs, callback) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
});
