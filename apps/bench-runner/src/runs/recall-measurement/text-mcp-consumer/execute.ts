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
  type TextMcpCeilings, type TextMcpConsumerExecution, type TextMcpConsumerInput, type TextMcpConsumerTerminal,
  type TextMcpDispatch, type TextMcpLiveSurface, type TextMcpModelRequest, type TextMcpModelResult,
  type TextMcpResponseState, type TextMcpScriptedPort
} from "./contract.js";
import { bindTextMcpGatewayBody, decodeTextMcpAction, encodeTextMcpRequest, textMcpUtf8Bytes } from "./codec.js";

type TextMcpComplete = TextMcpScriptedPort["complete"];

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
  if (port === undefined || typeof port.complete !== "function") {
    throw new AlayaError("VALIDATION", "scripted text MCP consumer requires a complete() port");
  }
  const complete = port.complete.bind(port);
  const scope = currentBenchScope();
  const operation = async () => {
    refuseBenchWorkAfterCancel();
    return runTextMcpConsumer(input, complete);
  };
  return scope === undefined ? operation() : trackBenchOperation(scope, operation);
}

async function runTextMcpConsumer(
  input: TextMcpConsumerInput, complete: TextMcpComplete
): Promise<TextMcpConsumerExecution> {
  const config = SemanticChainConfigSchema.parse(structuredClone(input.config));
  assertTextMcpOutputRoot(input.root, config);
  const mapping = mapOrdinaryRecallScope(config.authorized_scopes);
  if (input.host_issued_initial_recall && mapping.status === "not_run") {
    return freezeExecution(emptyExecution(config, { outcome: "not_run", reason: mapping.reason }, false));
  }
  const started = performance.now();
  return withSemanticChainDaemon(config, input.root, async daemon => {
    refuseBenchWorkAfterCancel();
    const surface = await snapshotLiveMcpSurface(daemon.mcpClient);
    const events: Record<string, unknown>[] = [];
    let mcpDispatches = 0;
    let hostSetup = false;
    if (input.host_issued_initial_recall && mapping.status === "mapped") {
      const blocked = textMcpDispatchBudget(started, input.ceilings, mcpDispatches);
      if (blocked !== null) {
        return freezeExecution(completeExecution(config, surface, false, {
          events, modelCalls: 0, mcpDispatches, terminal: blocked
        }));
      }
      const args = structuredClone(buildOrdinaryRecallRequest({
        query: input.query.original_query, scope_class: mapping.scope_class,
        source_observed_at: config.interpretation_clock,
        ...(input.query.interpretation_proposal === undefined
          ? {} : { interpretation_proposal: input.query.interpretation_proposal })
      }));
      const dispatched = await dispatchTextMcpRead(daemon.mcpClient, "soul.recall", args);
      mcpDispatches += 1;
      hostSetup = true;
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
      daemon, complete, input, surface, events, started, mcpDispatches
    });
    return freezeExecution(completeExecution(config, surface, hostSetup, loop));
  });
}

async function runTextMcpLoop(input: Readonly<{
  daemon: BenchDaemonHandle; complete: TextMcpComplete; input: TextMcpConsumerInput;
  surface: TextMcpLiveSurface; events: Record<string, unknown>[]; started: number; mcpDispatches: number;
}>): Promise<{
  events: Record<string, unknown>[]; modelCalls: number; mcpDispatches: number; terminal: TextMcpConsumerTerminal;
}> {
  const { daemon, complete, surface, events } = input, ceilings = input.input.ceilings;
  const query = input.input.query.original_query;
  let modelCalls = 0, mcpDispatches = input.mcpDispatches;
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
    const model = await awaitOwnedTextMcpModel(complete, request, input.started, ceilings.wall_ms);
    if (model.status === "cancelled") throw cancelledTextMcpTurn();
    if (model.status === "time_ceiling") { terminal = { outcome: "time_ceiling" }; break; }
    if (model.status === "failed") { terminal = { outcome: "model_failure", reason: model.reason }; break; }
    if (Buffer.byteLength(model.text, "utf8") > ceilings.max_output_bytes) {
      events.push(modelTurnEvent(request.gatewayBody, model, { kind: "invalid_action", reason: "output_ceiling" }));
      terminal = { outcome: "output_ceiling" }; break;
    }
    const finish = textMcpFinishTerminal(model.finishReason);
    const decoded = decodeTextMcpAction(model.text);
    events.push(modelTurnEvent(request.gatewayBody, model, decoded));
    if (finish !== null) { terminal = finish; break; }
    refuseBenchWorkAfterCancel();
    if (decoded.kind === "answer") { terminal = { outcome: "answered", text: decoded.text }; break; }
    if (decoded.kind === "invalid_action") { terminal = { outcome: "invalid_action", reason: decoded.reason }; break; }
    if (decoded.kind === "host_policy_refusal") {
      terminal = { outcome: "host_policy_refusal", tool: decoded.tool, reason: decoded.reason }; break;
    }
    const blocked = textMcpDispatchBudget(input.started, ceilings, mcpDispatches);
    if (blocked !== null) { terminal = blocked; break; }
    const dispatched = await dispatchTextMcpRead(daemon.mcpClient, decoded.tool, structuredClone(decoded.arguments));
    mcpDispatches += 1;
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

/** Default gateway chat-completions body completes only on `stop`. length/null/unknown are not ready. */
function textMcpFinishTerminal(finishReason: string | null): TextMcpConsumerTerminal | null {
  if (finishReason === "stop") return null;
  if (finishReason === "length") return { outcome: "model_incomplete", finishReason };
  return { outcome: "model_unknown", finishReason };
}

function textMcpDispatchBudget(
  started: number, ceilings: TextMcpCeilings, mcpDispatches: number
): TextMcpConsumerTerminal | null {
  if (performance.now() - started >= ceilings.wall_ms) return { outcome: "time_ceiling" };
  if (mcpDispatches >= ceilings.max_tool_calls) return { outcome: "tool_call_ceiling" };
  return null;
}

async function awaitOwnedTextMcpModel(
  complete: TextMcpComplete, request: TextMcpModelRequest, started: number, wallMs: number
): Promise<
  | { status: "ok"; text: string; finishReason: string | null }
  | { status: "failed"; reason: string }
  | { status: "time_ceiling" }
  | { status: "cancelled" }
> {
  refuseBenchWorkAfterCancel();
  const remaining = wallMs - (performance.now() - started);
  if (remaining <= 0) return { status: "time_ceiling" };
  const scope = currentBenchScope();
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
  const owned = scope === undefined ? timeout : AbortSignal.any([timeout, scope.signal]);
  const work = Promise.resolve().then(() => complete({ ...request, abortSignal: owned }));
  work.then(() => undefined, () => undefined);
  const aborted = waitOwnedAbort(owned, scope);
  const winner = await Promise.race([
    work.then(result => ({ kind: "returned" as const, result }), error => ({ kind: "threw" as const, error })),
    aborted.then(outcome => ({ kind: "aborted" as const, outcome }))
  ]);
  if (winner.kind === "aborted") return winner.outcome;
  if (owned.aborted) return abortOutcome(scope);
  if (winner.kind === "threw") {
    if (winner.error instanceof AlayaError && (winner.error.code === "CANCELLED" || winner.error.code === "CONFLICT")) {
      throw winner.error;
    }
    return { status: "failed", reason: winner.error instanceof Error ? winner.error.message : String(winner.error) };
  }
  return readReturnedModel(winner.result);
}

function waitOwnedAbort(
  owned: AbortSignal, scope: ReturnType<typeof currentBenchScope>
): Promise<{ status: "time_ceiling" } | { status: "cancelled" }> {
  return new Promise(resolve => {
    const finish = () => resolve(abortOutcome(scope));
    if (owned.aborted) finish();
    else owned.addEventListener("abort", finish, { once: true });
  });
}

function abortOutcome(scope: ReturnType<typeof currentBenchScope>):
  { status: "time_ceiling" } | { status: "cancelled" } {
  if (scope?.cancelled === true || scope?.signal.aborted === true) return { status: "cancelled" };
  return { status: "time_ceiling" };
}

function readReturnedModel(result: TextMcpModelResult):
  { status: "ok"; text: string; finishReason: string | null } | { status: "failed"; reason: string } {
  if (typeof result?.text !== "string") return { status: "failed", reason: "model result text is not a string" };
  return {
    status: "ok", text: result.text,
    finishReason: typeof result.finishReason === "string" ? result.finishReason : null
  };
}

function cancelledTextMcpTurn(): AlayaError {
  return new AlayaError("CANCELLED", "bench scope was cancelled before new work could start");
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
