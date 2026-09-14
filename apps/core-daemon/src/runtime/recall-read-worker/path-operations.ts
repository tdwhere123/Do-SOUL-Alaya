import type { RecallReadWorkerRequest } from "./protocol.js";
import type { WorkerOperationPayload, WorkerOperationPayloadMap } from "./operation-schemas.js";
import { readPathProjectionReadOptions } from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type PathOperation = Extract<
  RecallReadWorkerRequest["operation"],
  `path${string}` | "pathPlasticity.getStrengthByMemoryId"
>;

export async function runPathOperation(
  runtime: RecallReadWorkerRuntime,
  operation: PathOperation,
  payload: WorkerOperationPayloadMap[PathOperation]
) {
  const options = readPathProjectionReadOptions(payload);
  if (operation === "path.findByAnchors") {
    const anchorPayload = payload as WorkerOperationPayload<"path.findByAnchors">;
    return await runtime.recallPathReadPorts.pathExpansionPort.findByAnchors(
      anchorPayload.workspaceId,
      anchorPayload.anchorRefs,
      options
    );
  }
  if (operation === "pathPlasticity.getStrengthByMemoryId") {
    const strengthPayload = payload as WorkerOperationPayload<"pathPlasticity.getStrengthByMemoryId">;
    const strengths = await runtime.recallPathReadPorts.pathPlasticityPort.getStrengthByMemoryId(
      strengthPayload.workspaceId,
      strengthPayload.memoryIds,
      options
    );
    return [...strengths.entries()];
  }
  const digestPayload = payload as WorkerOperationPayload<"path.findByTimeConcernWindowDigests">;
  return await runtime.recallPathReadPorts.pathExpansionPort.findByTimeConcernWindowDigests(
    digestPayload.workspaceId,
    digestPayload.windowDigests,
    options
  );
}
