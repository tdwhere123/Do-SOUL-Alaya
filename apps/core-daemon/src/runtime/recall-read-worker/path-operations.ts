import type { RecallReadWorkerRequest } from "./protocol.js";
import {
  readString,
  readStringArray
} from "./payload-readers.js";
import {
  readAnchorRefs,
  readPathProjectionReadOptions
} from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

export async function runPathOperation(
  runtime: RecallReadWorkerRuntime,
  operation: Extract<RecallReadWorkerRequest["operation"], `path${string}`>,
  payload: Record<string, unknown>
) {
  const options = readPathProjectionReadOptions(payload);
  if (operation === "path.findByAnchors") {
    return await runtime.recallPathReadPorts.pathExpansionPort.findByAnchors(
      readString(payload.workspaceId, "workspaceId"),
      readAnchorRefs(payload.anchorRefs),
      options
    );
  }
  if (operation === "pathPlasticity.getStrengthByMemoryId") {
    const strengths = await runtime.recallPathReadPorts.pathPlasticityPort.getStrengthByMemoryId(
      readString(payload.workspaceId, "workspaceId"),
      readStringArray(payload.memoryIds, "memoryIds"),
      options
    );
    return [...strengths.entries()];
  }

  return await runtime.recallPathReadPorts.pathExpansionPort.findByTimeConcernWindowDigests(
    readString(payload.workspaceId, "workspaceId"),
    readStringArray(payload.windowDigests, "windowDigests"),
    options
  );
}
