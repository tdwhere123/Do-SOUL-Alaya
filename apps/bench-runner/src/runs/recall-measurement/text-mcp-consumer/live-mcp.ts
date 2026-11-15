import { AlayaError } from "@do-soul/alaya-protocol";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callMcpTool, type BenchMcpToolCapture } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { canonicalPath, canonicalPathsOverlap } from "../../fs/opened-contained-path.js";
import { type SemanticChainConfig } from "../contract.js";
import { semanticChainCacheInputPaths } from "../inputs.js";
import {
  type TextMcpDispatch, type TextMcpLiveSurface, type TextMcpResponseState
} from "./contract.js";

export async function snapshotLiveMcpSurface(client: Client): Promise<TextMcpLiveSurface> {
  const instructions = client.getInstructions();
  const listed = await client.listTools();
  return {
    instructions_status: instructions === undefined ? "absent" : "present",
    instructions: instructions === undefined ? null : instructions,
    version: client.getServerVersion() ?? null,
    capabilities: client.getServerCapabilities() ?? null,
    tools: structuredClone(listed.tools)
  };
}

export async function dispatchTextMcpRead(
  client: Client, name: string, args: Record<string, unknown>
): Promise<TextMcpDispatch> {
  const capturedArgs = structuredClone(args);
  let frame: BenchMcpToolCapture | undefined;
  try {
    await callMcpTool(client, name, capturedArgs, captured => { frame = captured; });
  } catch (error) {
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    if (frame === undefined) {
      return { tool: name, arguments: capturedArgs, response_state: "transport_error", envelope: null };
    }
  }
  if (frame === undefined) {
    return { tool: name, arguments: capturedArgs, response_state: "unknown", envelope: null };
  }
  return {
    tool: name, arguments: structuredClone(frame.request.arguments),
    response_state: classifyEnvelope(frame.response), envelope: structuredClone(frame.response)
  };
}

export function assertTextMcpOutputRoot(root: string, config: SemanticChainConfig): void {
  const physicalRoot = canonicalPath(root);
  for (const input of [config.snapshot_path, ...semanticChainCacheInputPaths({ config })]) {
    if (canonicalPathsOverlap(physicalRoot, canonicalPath(input))) {
      throw new AlayaError("VALIDATION", "text MCP consumer output root must be separate from the sealed snapshot and cache inputs");
    }
  }
}

function classifyEnvelope(response: unknown): TextMcpResponseState {
  if (response === null || typeof response !== "object") return "invalid_response";
  const record = response as Record<string, unknown>;
  if (record.isError === true) return "public_error";
  if (!Array.isArray(record.content)) return "invalid_response";
  return "received";
}
