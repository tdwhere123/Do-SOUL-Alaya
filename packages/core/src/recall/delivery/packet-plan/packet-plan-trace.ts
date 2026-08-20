import { deepFreeze } from "../../../shared/deep-freeze.js";
import type { RecallPacketPlanObservation } from "./packet-plan-observation.js";

export type RecallPacketPlanPath = "legacy" | "snapshot";

export type RecallPacketPlanTrace = Readonly<{
  readonly schema_version: 3;
  readonly assessment_path: RecallPacketPlanPath;
  readonly added_candidate_keys: readonly string[];
  readonly removed_candidate_keys: readonly string[];
}> & RecallPacketPlanObservation;

export type RecallPacketPlanTraceCaptureResult =
  | Readonly<{
      readonly status: "captured";
      readonly trace: RecallPacketPlanTrace;
    }>
  | Readonly<{
      readonly status: "failed";
      readonly failure: Readonly<{
        readonly code: "packet_plan_trace_projection_failed";
        readonly error_name: string;
      }>;
    }>;

export function captureSupportSetPacketPlanTrace(
  assessmentPath: RecallPacketPlanPath,
  observation: RecallPacketPlanObservation
): RecallPacketPlanTraceCaptureResult {
  try {
    return deepFreeze({
      status: "captured" as const,
      trace: {
        schema_version: 3,
        assessment_path: assessmentPath,
        ...observation,
        added_candidate_keys: deriveAddedKeys(
          observation.baseline_candidate_keys,
          observation.planned_candidate_keys
        ),
        removed_candidate_keys: deriveRemovedKeys(
          observation.baseline_candidate_keys,
          observation.planned_candidate_keys
        )
      }
    });
  } catch (error) {
    return deepFreeze({
      status: "failed" as const,
      failure: {
        code: "packet_plan_trace_projection_failed" as const,
        error_name: error instanceof Error ? error.name : "UnknownError"
      }
    });
  }
}

function deriveAddedKeys(
  baselineKeys: readonly string[],
  plannedKeys: readonly string[]
): readonly string[] {
  const baselineSet = new Set(baselineKeys);
  return plannedKeys.filter((candidateKey) => !baselineSet.has(candidateKey));
}

function deriveRemovedKeys(
  baselineKeys: readonly string[],
  plannedKeys: readonly string[]
): readonly string[] {
  const plannedSet = new Set(plannedKeys);
  return baselineKeys.filter((candidateKey) => !plannedSet.has(candidateKey));
}
