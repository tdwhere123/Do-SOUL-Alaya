import { AlayaError } from "@do-soul/alaya-protocol";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { currentBenchScope, refuseBenchWorkAfterCancel, trackBenchOperation } from "../../../harness/daemon-task.js";
import { callMcpTool, type BenchMcpToolCapture } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import type { BenchDaemonHandle } from "../../../harness/daemon.js";
import { canonicalPath, canonicalPathsOverlap } from "../../fs/opened-contained-path.js";
import {
  SemanticChainConfigSchema, withSemanticChainDaemon, type SemanticChainConfig
} from "../contract.js";
import { semanticChainCacheInputPaths } from "../inputs.js";
import { buildOrdinaryRecallRequest, mapOrdinaryRecallScope } from "../ordinary/ordinary-entry-contract.js";
import {
  TEXT_MCP_CONSUMER_CONTRACT, TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION, TEXT_MCP_CONSUMER_PAID_READINESS,
  TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE, TextMcpConsumerExecutionSchema, TextMcpConsumerInputSchema,
  type TextMcpConsumerExecution, type TextMcpConsumerInput, type TextMcpConsumerTerminal,
  type TextMcpDispatch, type TextMcpLiveSurface, type TextMcpResponseState, type TextMcpScriptedPort
} from "./contract.js";
import { bindTextMcpGatewayBody, decodeTextMcpAction, encodeTextMcpRequest, textMcpUtf8Bytes } from "./codec.js";

/**
 * Bounded text-mediated MCP consumer. One `withSemanticChainDaemon` lifetime.
 * Scripted complete() is the local fixture port; remote execution is refused here.
 */
export async function executeTextMcpConsumer(
  value: unknown, port?: TextMcpScriptedPort
): Promise<TextMcpConsumerExecution> {
  const input = TextMcpConsumerInputSchema.parse(structuredClone(value));
  if (input.model_kind === "remote") {
    throw new AlayaError("UNAVAILABLE", TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE);
  }
  if (port === undefined) {
    throw new AlayaError("VALIDATION", "scripted text MCP consumer requires a complete() port");
  }
  const capturedPort = port;
  const scope = currentBenchScope();
  const operation = async () => {
    refuseBenchWorkAfterCancel();
    return runTextMcpConsumer(input, capturedPort);
  };
  return scope === undefined ? operation() : trackBenchOperation(scope, operation);
}

async function runTextMcpConsumer(
  input: TextMcpConsumerInput, port: TextMcpScriptedPort
): Promise<TextMcpConsumerExecution> {
  const config = SemanticChainConfigSchema.parse(structuredClone(input.config));
  assertTextMcpOutputRoot(input.root, config);
  const mapping = mapOrdinaryRecallScope(config.authorized_scopes);
  if (input.host_issued_initial_recall && mapping.status === "not_run") {
    return freezeExecution(emptyExecution(config, {
      outcome: "not_run", reason: mapping.reason
    }, false));
  }
  const started = performance.now();
  return withSemanticChainDaemon(config, input.root, async daemon => {
    refuseBenchWorkAfterCancel();
    const surface = await snapshotLiveMcpSurface(daemon.mcpClient);
    const events: Record<string, unknown>[] = [];
    let mcpDispatches = 0;
    if (input.host_issued_initial_recall && mapping.status === "mapped") {
      const args = structuredClone(buildOrdinaryRecallRequest({
        query: input.query.original_query, scope_class: mapping.scope_class,
        source_observed_at: config.interpretation_clock
      }));
      const dispatched = await dispatchTextMcpRead(daemon.mcpClient, "soul.recall", args);
      mcpDispatches += 1;
      events.push({
        kind: "host_setup", generated_by: "host_controlled_setup", tool: dispatched.tool,
        arguments: dispatched.arguments, response_state: dispatched.response_state, envelope: dispatched.envelope
      });
      if (dispatched.response_state === "transport_error" || dispatched.response_state === "unknown"
        || dispatched.response_state === "invalid_response") {
        return freezeExecution(completeExecution(config, surface, true, {
          events, modelCalls: 0, mcpDispatches,
          terminal: { outcome: "unresolved_delivery", response_state: dispatched.response_state }
        }));
      }
    }
    const loop = await runTextMcpLoop({
      daemon, port, input, surface, events, started, mcpDispatches
    });
    return freezeExecution(completeExecution(config, surface, input.host_issued_initial_recall, loop));
  });
}

async function runTextMcpLoop(input: Readonly<{
  daemon: BenchDaemonHandle; port: TextMcpScriptedPort; input: TextMcpConsumerInput;
  surface: TextMcpLiveSurface; events: Record<string, unknown>[]; started: number; mcpDispatches: number;
}>): Promise<{
  events: Record<string, unknown>[]; modelCalls: number; mcpDispatches: number; terminal: TextMcpConsumerTerminal;
}> {
  const { daemon, port, surface, events } = input, ceilings = input.input.ceilings;
  const query = input.input.query.original_query;
  let modelCalls = 0, mcpDispatches = input.mcpDispatches, modelSelectedTools = 0;
  let terminal: TextMcpConsumerTerminal | null = null;
  while (terminal === null) {
    refuseBenchWorkAfterCancel();
    if (performance.now() - input.started >= ceilings.wall_ms) { terminal = { outcome: "time_ceiling" }; break; }
    if (modelCalls >= ceilings.max_model_turns) { terminal = { outcome: "model_turn_ceiling" }; break; }
    const encoded = encodeTextMcpRequest({ surface, query, events });
    if (textMcpUtf8Bytes(encoded) > ceilings.max_input_bytes) { terminal = { outcome: "input_ceiling" }; break; }
    const gatewayBody = bindTextMcpGatewayBody(encoded);
    const request = {
      systemPrompt: encoded.systemPrompt, userPrompt: encoded.userPrompt, gatewayBody: structuredClone(gatewayBody)
    };
    modelCalls += 1;
    const model = await readModelResult(port, request);
    if (model.status === "failed") { terminal = { outcome: "model_failure", reason: model.reason }; break; }
    if (Buffer.byteLength(model.text, "utf8") > ceilings.max_output_bytes) {
      events.push(modelTurnEvent(request.gatewayBody, model, { kind: "invalid_action", reason: "output_ceiling" }));
      terminal = { outcome: "output_ceiling" }; break;
    }
    refuseBenchWorkAfterCancel();
    const decoded = decodeTextMcpAction(model.text);
    events.push(modelTurnEvent(request.gatewayBody, model, decoded));
    if (decoded.kind === "answer") { terminal = { outcome: "answered", text: decoded.text }; break; }
    if (decoded.kind === "invalid_action") { terminal = { outcome: "invalid_action", reason: decoded.reason }; break; }
    if (decoded.kind === "host_policy_refusal") {
      terminal = { outcome: "host_policy_refusal", tool: decoded.tool, reason: decoded.reason }; break;
    }
    if (modelSelectedTools >= ceilings.max_tool_calls) { terminal = { outcome: "tool_call_ceiling" }; break; }
    if (performance.now() - input.started >= ceilings.wall_ms) { terminal = { outcome: "time_ceiling" }; break; }
    const args = structuredClone(decoded.arguments);
    const dispatched = await dispatchTextMcpRead(daemon.mcpClient, decoded.tool, args);
    mcpDispatches += 1;
    modelSelectedTools += 1;
    events.push({
      kind: "mcp_call", origin: "model_selected", tool: dispatched.tool, arguments: dispatched.arguments,
      response_state: dispatched.response_state, envelope: dispatched.envelope
    });
    if (dispatched.response_state === "transport_error" || dispatched.response_state === "unknown"
      || dispatched.response_state === "invalid_response") {
      terminal = { outcome: "unresolved_delivery", response_state: dispatched.response_state }; break;
    }
  }
  return { events, modelCalls, mcpDispatches, terminal: terminal ?? { outcome: "model_turn_ceiling" } };
}

async function snapshotLiveMcpSurface(client: Client): Promise<TextMcpLiveSurface> {
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

async function dispatchTextMcpRead(
  client: Client, name: string, args: Record<string, unknown>
): Promise<TextMcpDispatch> {
  const capturedArgs = structuredClone(args);
  let frame: BenchMcpToolCapture | undefined;
  try {
    await callMcpTool(client, name, capturedArgs, captured => { frame = captured; });
  } catch (error) {
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    if (frame === undefined) {
      return {
        tool: name, arguments: capturedArgs, response_state: "transport_error", envelope: null
      };
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

async function readModelResult(
  port: TextMcpScriptedPort, request: Parameters<TextMcpScriptedPort["complete"]>[0]
): Promise<{ status: "ok"; text: string; finishReason: string | null } | { status: "failed"; reason: string }> {
  try {
    const result = await port.complete(request);
    if (typeof result?.text !== "string") return { status: "failed", reason: "model result text is not a string" };
    return { status: "ok", text: result.text, finishReason: result.finishReason ?? null };
  } catch (error) {
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

function classifyEnvelope(response: unknown): TextMcpResponseState {
  if (response === null || typeof response !== "object") return "invalid_response";
  const record = response as Record<string, unknown>;
  if (record.isError === true) return "public_error";
  if (!Array.isArray(record.content)) return "invalid_response";
  return "received";
}

function modelTurnEvent(
  gatewayBody: Record<string, unknown>,
  model: { text: string; finishReason: string | null },
  decoded: unknown
): Record<string, unknown> {
  return {
    kind: "model_turn", gatewayBody: structuredClone(gatewayBody),
    model_text: model.text, finishReason: model.finishReason, decoded: structuredClone(decoded)
  };
}

function completeExecution(
  config: SemanticChainConfig, surface: TextMcpLiveSurface, hostSetup: boolean,
  loop: { events: Record<string, unknown>[]; modelCalls: number; mcpDispatches: number; terminal: TextMcpConsumerTerminal }
): TextMcpConsumerExecution {
  return {
    ...baseExecution(config, hostSetup), live_surface: surface, consumer_model_calls: loop.modelCalls,
    mcp_dispatches: loop.mcpDispatches, events: loop.events, terminal: loop.terminal
  };
}

function emptyExecution(
  config: SemanticChainConfig, terminal: TextMcpConsumerTerminal, hostSetup: boolean
): TextMcpConsumerExecution {
  return {
    ...baseExecution(config, hostSetup), live_surface: null, consumer_model_calls: 0,
    mcp_dispatches: 0, events: [], terminal
  };
}

function baseExecution(config: SemanticChainConfig, hostSetup: boolean) {
  return {
    contract: TEXT_MCP_CONSUMER_CONTRACT, consumer_kind: "text_mediated_mcp" as const, model_kind: "scripted" as const,
    claims: {
      native_provider_tool_calling: false as const, cli_host_equivalence: false as const,
      answer_quality: "not_verified" as const
    },
    paid_readiness: { ...TEXT_MCP_CONSUMER_PAID_READINESS },
    diagnostic_restriction: TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION,
    host_setup: hostSetup, original_snapshot_sha256: config.snapshot_sha256
  };
}

function freezeExecution(value: TextMcpConsumerExecution): TextMcpConsumerExecution {
  return TextMcpConsumerExecutionSchema.parse(JSON.parse(JSON.stringify(value)));
}

function assertTextMcpOutputRoot(root: string, config: SemanticChainConfig): void {
  const physicalRoot = canonicalPath(root);
  for (const input of [config.snapshot_path, ...semanticChainCacheInputPaths({ config })]) {
    if (canonicalPathsOverlap(physicalRoot, canonicalPath(input))) {
      throw new AlayaError("VALIDATION", "text MCP consumer output root must be separate from the sealed snapshot and cache inputs");
    }
  }
}
