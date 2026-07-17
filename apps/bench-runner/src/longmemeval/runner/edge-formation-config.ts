import { shouldRunBenchEdgePlane } from
  "../../harness/daemon/handle/daemon-handle-ops-support.js";

export interface LongMemEvalEdgeFormationConfig {
  readonly edgePlaneEnabled: boolean;
  readonly coherence: {
    readonly enabled: boolean;
    readonly floor: number;
    readonly capPerNode: number;
    readonly crossSessionOnly: boolean;
  };
  readonly answersWith: {
    readonly bar: number;
    readonly capPerNode: number;
    readonly crossSessionOnly: boolean;
  };
}

export function resolveLongMemEvalEdgeFormationConfig(
  env: Readonly<Record<string, string | undefined>>
): LongMemEvalEdgeFormationConfig {
  return {
    edgePlaneEnabled: shouldRunBenchEdgePlane(env),
    coherence: {
      enabled: env.ALAYA_EXP_COHERENCE_EDGES === "1",
      floor: Number(env.ALAYA_EXP_COHERENCE_FLOOR ?? "0.6"),
      capPerNode: Number(env.ALAYA_EXP_COHERENCE_CAP ?? "3"),
      crossSessionOnly: env.ALAYA_EXP_COHERENCE_XSESSION !== "0"
    },
    answersWith: {
      bar: Number(env.ALAYA_EXP_ANSWERS_WITH_BAR ?? "3"),
      capPerNode: Number(env.ALAYA_EXP_ANSWERS_WITH_CAP ?? "3"),
      crossSessionOnly: env.ALAYA_EXP_ANSWERS_WITH_XSESSION !== "0"
    }
  };
}

export function assertLongMemEvalTreatmentNeutralEdgeFormation(
  env: Readonly<Record<string, string | undefined>>
): void {
  const config = resolveLongMemEvalEdgeFormationConfig(env);
  if (config.edgePlaneEnabled || config.coherence.enabled) {
    throw new Error(
      "snapshot producer seed-time edge formation must be disabled"
    );
  }
}
