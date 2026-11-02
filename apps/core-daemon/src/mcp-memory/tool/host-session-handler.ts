import {
  AlayaError, HostSessionCaptureResponseSchema, type HostSessionCaptureRequest, type HostSessionCaptureResponse
} from "@do-soul/alaya-protocol";
import { throwIfAborted } from "@do-soul/alaya-engine-gateway";
import { MCP_HOST_SESSION_ISSUER, type HostSessionCapture } from "../../garden/host-session/host-session-capture.js";
import type { McpMemoryToolCallContext } from "./tool-handler-types.js";

/** MCP host entry: the attached host asserts its messages; the daemon composition names the issuer. */
export function createHostSessionCaptureHandler(deps: Readonly<{ hostSessionCapture?: HostSessionCapture }>) {
  return async (request: HostSessionCaptureRequest, context: McpMemoryToolCallContext): Promise<HostSessionCaptureResponse> => {
    if (deps.hostSessionCapture === undefined) throw new AlayaError("UNAVAILABLE", "host session capture is unavailable");
    // Statement signals and memory entries keep the non-null run contract.
    if (context.runId === null) throw new AlayaError("VALIDATION", "host session capture requires an attached run");
    throwIfAborted(context.abortSignal);
    return HostSessionCaptureResponseSchema.parse(await deps.hostSessionCapture.capture({
      workspaceId: context.workspaceId, runId: context.runId, request, issuer: MCP_HOST_SESSION_ISSUER }));
  };
}
