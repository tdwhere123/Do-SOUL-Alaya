import type { DaemonStartupStepRecord, StartupStep } from "../lifecycle/daemon-runtime-types.js";

export const REQUIRED_STARTUP_STEPS = Object.freeze([
  "database", "repositories", "core-services", "garden-runtime", "mcp-tooling", "http-app"
] as const satisfies readonly StartupStep[]);

/** Readiness is independent of a command's formatting, health tolerance and exit policy. */
export function assessStartupReadiness(steps: readonly DaemonStartupStepRecord[]) {
  const completed_steps = steps.map((step) => step.step);
  const missing_steps = REQUIRED_STARTUP_STEPS.filter((step) => !completed_steps.includes(step));
  return { ready: missing_steps.length === 0, completed_steps, missing_steps };
}
