import type { RecallReadWorkerRequest } from "./protocol.js";
import type { ParsedWorkerOperation } from "./operation-schemas.js";
import { readPathProjectionReadOptions } from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type PathOperation = Extract<
  RecallReadWorkerRequest["operation"],
  `path${string}` | "pathPlasticity.getStrengthByMemoryId"
>;

export async function runPathOperation(
  runtime: RecallReadWorkerRuntime,
  parsed: ParsedWorkerOperation<PathOperation>
) {
  const options = readPathProjectionReadOptions(parsed.payload);
  if (parsed.operation === "path.findByAnchors") {
    const { payload } = parsed;
    return await runtime.recallPathReadPorts.pathExpansionPort.findByAnchors(
      payload.workspaceId,
      payload.anchorRefs,
      options
    );
  }
  if (parsed.operation === "pathPlasticity.getStrengthByMemoryId") {
    const { payload } = parsed;
    const strengths = await runtime.recallPathReadPorts.pathPlasticityPort.getStrengthByMemoryId(
      payload.workspaceId,
      payload.memoryIds,
      options
    );
    return [...strengths.entries()];
  }
  const { payload } = parsed;
  return await runtime.recallPathReadPorts.pathExpansionPort.findByTimeConcernWindowDigests(
    payload.workspaceId,
    payload.windowDigests,
    options
  );
}
