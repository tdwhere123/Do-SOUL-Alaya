export type BacklogPressureThresholds = Readonly<{
  readonly warning_queue_depth: number;
  readonly warning_rearm_depth: number;
}>;

export type BacklogPressureTransition = "arm" | "clear" | "none";

export function evaluateBacklogPressure(input: {
  readonly armed: boolean;
  readonly queueDepthTotal: number;
  readonly thresholds: BacklogPressureThresholds;
}): BacklogPressureTransition {
  if (!input.armed && input.queueDepthTotal > input.thresholds.warning_queue_depth) {
    return "arm";
  }

  if (input.armed && input.queueDepthTotal < input.thresholds.warning_rearm_depth) {
    return "clear";
  }

  return "none";
}
