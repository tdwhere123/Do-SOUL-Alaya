import { AlayaError } from "@do-soul/alaya-protocol";
import { currentBenchScope, refuseBenchWorkAfterCancel, trackBenchOperation } from "../../../harness/daemon-task.js";
import type { BenchDaemonHandle } from "../../../harness/daemon.js";
import {
  SemanticChainConfigSchema, withSemanticChainDaemon, type SemanticChainConfig
} from "../contract.js";
import { buildOrdinaryRecallRequest, mapOrdinaryRecallScope } from "../ordinary/ordinary-entry-contract.js";
import {
  TEXT_MCP_CONSUMER_CONTRACT, TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION, TEXT_MCP_CONSUMER_PAID_READINESS,
  TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE, TEXT_MCP_WALL_MS_MEANING, TextMcpConsumerExecutionSchema,
  TextMcpConsumerInputSchema, isUnresolvedTextMcpDelivery, type TextMcpCeilings, type TextMcpConsumerExecution,
  type TextMcpConsumerInput, type TextMcpConsumerTerminal, type TextMcpLiveSurface, type TextMcpModelRequest,
  type TextMcpModelResult, type TextMcpModelWorkStatus, type TextMcpScriptedPort
} from "./contract.js";
import { bindTextMcpGatewayBody, decodeTextMcpAction, encodeTextMcpRequest, textMcpUtf8Bytes } from "./codec.js";
import { assertTextMcpOutputRoot, dispatchTextMcpRead, snapshotLiveMcpSurface } from "./live-mcp.js";
import {
  recallDispatchEventFields, resolveTextMcpRecallDispatch, textMcpPromptOptions
} from "./caller-capability-profile.js";

type TextMcpComplete = TextMcpScriptedPort["complete"];

/**
 * Bounded text-mediated MCP consumer. One `withSemanticChainDaemon` lifetime.
 * Scripted complete() is the local fixture port; remote execution is refused here.
 * wall_ms is an admission/wait budget, not preemption of in-process complete().
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
  const completeFn = port.complete;
  if (typeof completeFn !== "function") {
    throw new AlayaError("VALIDATION", "scripted text MCP consumer requires a complete() port");
  }
  const complete = completeFn.bind(port);
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
    return freezeExecution(emptyExecution(config, { outcome: "not_run", reason: mapping.reason }, false, "idle",
      input.caller_capability_profile));
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
        const terminal = blocked.outcome === "time_ceiling"
          ? { outcome: "time_ceiling" as const, model_work: "idle" as const } : blocked;
        return freezeExecution(completeExecution(config, surface, false, {
          events, modelCalls: 0, mcpDispatches, terminal, modelWork: "idle"
        }, input.caller_capability_profile));
      }
      const args = structuredClone(buildOrdinaryRecallRequest({
        query: input.query.original_query, scope_class: mapping.scope_class,
        source_observed_at: config.interpretation_clock,
        ...(input.query.interpretation_proposal === undefined
          ? {} : { interpretation_proposal: input.query.interpretation_proposal })
      }));
      const resolved = resolveTextMcpRecallDispatch({
        profile: input.caller_capability_profile, tool: "soul.recall", rawArguments: args,
        defaults: input.recall_dispatch_defaults
      });
      if (resolved.kind === "refuse") {
        return freezeExecution(completeExecution(config, surface, false, {
          events, modelCalls: 0, mcpDispatches, modelWork: "idle",
          terminal: { outcome: "host_policy_refusal", tool: resolved.tool, reason: resolved.reason }
        }, input.caller_capability_profile));
      }
      const dispatched = await dispatchTextMcpRead(daemon.mcpClient, "soul.recall", resolved.arguments);
      mcpDispatches += 1;
      hostSetup = true;
      events.push({
        kind: "host_setup", generated_by: "host_controlled_setup", tool: dispatched.tool,
        arguments: dispatched.arguments, response_state: dispatched.response_state, envelope: dispatched.envelope,
        ...recallDispatchEventFields(resolved)
      });
      if (isUnresolvedTextMcpDelivery(dispatched.response_state)) {
        return freezeExecution(completeExecution(config, surface, true, {
          events, modelCalls: 0, mcpDispatches, modelWork: "idle",
          terminal: { outcome: "unresolved_delivery", response_state: dispatched.response_state }
        }));
      }
    }
    const loop = await runTextMcpLoop({
      daemon, complete, input, surface, events, started, mcpDispatches
    });
    return freezeExecution(completeExecution(config, surface, hostSetup, loop, input.caller_capability_profile));
  });
}

async function runTextMcpLoop(input: Readonly<{
  daemon: BenchDaemonHandle; complete: TextMcpComplete; input: TextMcpConsumerInput;
  surface: TextMcpLiveSurface; events: Record<string, unknown>[]; started: number; mcpDispatches: number;
}>): Promise<{
  events: Record<string, unknown>[]; modelCalls: number; mcpDispatches: number;
  terminal: TextMcpConsumerTerminal; modelWork: TextMcpModelWorkStatus;
}> {
  const { daemon, complete, surface, events } = input, ceilings = input.input.ceilings;
  const query = input.input.query.original_query;
  let modelCalls = 0, mcpDispatches = input.mcpDispatches, modelWork: TextMcpModelWorkStatus = "idle";
  let terminal: TextMcpConsumerTerminal | null = null;
  while (terminal === null) {
    refuseBenchWorkAfterCancel();
    if (performance.now() - input.started >= ceilings.wall_ms) {
      terminal = { outcome: "time_ceiling", model_work: modelWork }; break;
    }
    if (modelCalls >= ceilings.max_model_turns) { terminal = { outcome: "model_turn_ceiling" }; break; }
    const encoded = encodeTextMcpRequest({
      surface, query, events, ...textMcpPromptOptions(input.input)
    });
    if (textMcpUtf8Bytes(encoded) > ceilings.max_input_bytes) { terminal = { outcome: "input_ceiling" }; break; }
    const gatewayBody = bindTextMcpGatewayBody(encoded);
    const request = {
      systemPrompt: encoded.systemPrompt, userPrompt: encoded.userPrompt, gatewayBody: structuredClone(gatewayBody)
    };
    if (performance.now() - input.started >= ceilings.wall_ms) {
      terminal = { outcome: "time_ceiling", model_work: modelWork }; break;
    }
    const model = await awaitOwnedTextMcpModel(complete, request, input.started, ceilings.wall_ms);
    if (model.invoked) modelCalls += 1;
    if (model.status === "cancelled") throw cancelledTextMcpTurn(model.model_work);
    if (model.status === "time_ceiling") {
      if (model.invoked) modelWork = model.model_work;
      terminal = { outcome: "time_ceiling", model_work: model.invoked ? model.model_work : modelWork }; break;
    }
    if (model.status === "failed") {
      modelWork = "settled";
      terminal = { outcome: "model_failure", reason: model.reason }; break;
    }
    if (performance.now() - input.started >= ceilings.wall_ms) {
      modelWork = "settled_late";
      terminal = { outcome: "time_ceiling", model_work: "settled_late" }; break;
    }
    modelWork = "settled";
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
    const follow = await followDecodedRead(input, decoded, events, mcpDispatches);
    mcpDispatches = follow.mcpDispatches;
    if (follow.terminal !== null) { terminal = follow.terminal; break; }
  }
  return { events, modelCalls, mcpDispatches, modelWork, terminal: terminal ?? { outcome: "model_turn_ceiling" } };
}

async function followDecodedRead(
  input: Readonly<{
    daemon: BenchDaemonHandle; input: TextMcpConsumerInput; started: number;
  }>,
  decoded: Extract<ReturnType<typeof decodeTextMcpAction>, { kind: "read" }>,
  events: Record<string, unknown>[], mcpDispatches: number
): Promise<{ terminal: TextMcpConsumerTerminal | null; mcpDispatches: number }> {
  const blocked = textMcpDispatchBudget(input.started, input.input.ceilings, mcpDispatches);
  if (blocked !== null) {
    return {
      mcpDispatches,
      terminal: blocked.outcome === "time_ceiling" ? { outcome: "time_ceiling", model_work: "settled" } : blocked
    };
  }
  const resolved = resolveTextMcpRecallDispatch({
    profile: input.input.caller_capability_profile, tool: decoded.tool,
    rawArguments: structuredClone(decoded.arguments), defaults: input.input.recall_dispatch_defaults
  });
  if (resolved.kind === "refuse") {
    return {
      mcpDispatches,
      terminal: { outcome: "host_policy_refusal", tool: resolved.tool, reason: resolved.reason }
    };
  }
  const dispatched = await dispatchTextMcpRead(input.daemon.mcpClient, resolved.tool, resolved.arguments);
  events.push({
    kind: "mcp_call", origin: "model_selected", tool: dispatched.tool, arguments: dispatched.arguments,
    response_state: dispatched.response_state, envelope: dispatched.envelope,
    ...recallDispatchEventFields(resolved)
  });
  if (isUnresolvedTextMcpDelivery(dispatched.response_state)) {
    return {
      mcpDispatches: mcpDispatches + 1,
      terminal: { outcome: "unresolved_delivery", response_state: dispatched.response_state }
    };
  }
  return { mcpDispatches: mcpDispatches + 1, terminal: null };
}

/** Default gateway chat-completions body completes only on `stop`. length/null/unknown are not ready. */
function textMcpFinishTerminal(finishReason: string | null): TextMcpConsumerTerminal | null {
  if (finishReason === "stop") return null;
  if (finishReason === "length") return { outcome: "model_incomplete", finishReason };
  return { outcome: "model_unknown", finishReason };
}

function textMcpDispatchBudget(
  started: number, ceilings: TextMcpCeilings, mcpDispatches: number
): Extract<TextMcpConsumerTerminal, { outcome: "time_ceiling" | "tool_call_ceiling" }> | null {
  if (performance.now() - started >= ceilings.wall_ms) return { outcome: "time_ceiling", model_work: "idle" };
  if (mcpDispatches >= ceilings.max_tool_calls) return { outcome: "tool_call_ceiling" };
  return null;
}

async function awaitOwnedTextMcpModel(
  complete: TextMcpComplete, request: TextMcpModelRequest, started: number, wallMs: number
): Promise<
  | { invoked: true; status: "ok"; text: string; finishReason: string | null }
  | { invoked: true; status: "failed"; reason: string }
  | { invoked: false; status: "time_ceiling"; model_work: "idle" }
  | { invoked: true; status: "time_ceiling"; model_work: Exclude<TextMcpModelWorkStatus, "idle" | "settled"> }
  | { invoked: true; status: "cancelled"; model_work: Exclude<TextMcpModelWorkStatus, "idle"> }
> {
  refuseBenchWorkAfterCancel();
  const scope = currentBenchScope();
  const turn = new AbortController();
  if (performance.now() - started >= wallMs) return { invoked: false, status: "time_ceiling", model_work: "idle" };
  // Keep admission and invocation in one turn: deferring the callback lets cancellation
  // become observable before previously admitted model work actually starts.
  let work: Promise<TextMcpModelResult>;
  try { work = Promise.resolve(complete({ ...request, abortSignal: turn.signal })); }
  catch (error) { work = Promise.reject(error); }
  const wait = startModelWait(started, wallMs, scope);
  work.then(() => undefined, () => undefined);
  const winner = await Promise.race([
    work.then(result => ({ kind: "returned" as const, result }), error => ({ kind: "threw" as const, error })),
    wait.promise.then(why => ({ kind: "wait" as const, why }))
  ]);
  wait.dispose();
  if (winner.kind === "returned" || winner.kind === "threw") {
    return settleReturnedModel(winner, started, wallMs, scope);
  }
  turn.abort();
  const acked = await observeModelAck(work);
  const model_work = acked ? "acked" as const : "unsettled_unknown" as const;
  if (scope?.cancelled === true || scope?.signal.aborted === true) {
    return { invoked: true, status: "cancelled", model_work };
  }
  return { invoked: true, status: "time_ceiling", model_work };
}

function startModelWait(
  started: number, wallMs: number, scope: ReturnType<typeof currentBenchScope>
): { promise: Promise<"time" | "cancel">; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCancel: (() => void) | undefined;
  const promise = new Promise<"time" | "cancel">(resolve => {
    const remaining = Math.max(1, Math.ceil(wallMs - (performance.now() - started)));
    timer = setTimeout(() => resolve("time"), remaining);
    if (scope === undefined) return;
    onCancel = () => resolve("cancel");
    if (scope.cancelled || scope.signal.aborted) resolve("cancel");
    else scope.signal.addEventListener("abort", onCancel, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (onCancel !== undefined && scope !== undefined) {
        scope.signal.removeEventListener("abort", onCancel);
        onCancel = undefined;
      }
    }
  };
}

function settleReturnedModel(
  winner: { kind: "returned"; result: TextMcpModelResult } | { kind: "threw"; error: unknown },
  started: number, wallMs: number, scope: ReturnType<typeof currentBenchScope>
): Awaited<ReturnType<typeof awaitOwnedTextMcpModel>> {
  if (performance.now() - started >= wallMs) {
    return { invoked: true, status: "time_ceiling", model_work: "settled_late" };
  }
  if (scope?.cancelled === true || scope?.signal.aborted === true) {
    return { invoked: true, status: "cancelled", model_work: "settled" };
  }
  if (winner.kind === "threw") {
    if (winner.error instanceof AlayaError && (winner.error.code === "CANCELLED" || winner.error.code === "CONFLICT")) {
      throw winner.error;
    }
    return {
      invoked: true, status: "failed",
      reason: winner.error instanceof Error ? winner.error.message : String(winner.error)
    };
  }
  return { invoked: true, ...readReturnedModel(winner.result) };
}

function observeModelAck(work: Promise<unknown>): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    work.then(() => { settled = true; resolve(true); }, () => { settled = true; resolve(true); });
    // A cooperative port may settle its promise on a following microtask.
    queueMicrotask(() => queueMicrotask(() => { if (!settled) resolve(false); }));
  });
}

function readReturnedModel(result: TextMcpModelResult):
  { status: "ok"; text: string; finishReason: string | null } | { status: "failed"; reason: string } {
  if (typeof result?.text !== "string") return { status: "failed", reason: "model result text is not a string" };
  return {
    status: "ok", text: result.text,
    finishReason: typeof result.finishReason === "string" ? result.finishReason : null
  };
}

function cancelledTextMcpTurn(modelWork: Exclude<TextMcpModelWorkStatus, "idle">): AlayaError {
  return new AlayaError(
    "CANCELLED",
    `bench scope was cancelled before new work could start; model_work=${modelWork}`,
    { cause: { model_work: modelWork, wall_ms_meaning: TEXT_MCP_WALL_MS_MEANING } }
  );
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
  loop: {
    events: Record<string, unknown>[]; modelCalls: number; mcpDispatches: number;
    terminal: TextMcpConsumerTerminal; modelWork: TextMcpModelWorkStatus;
  },
  profile?: TextMcpConsumerInput["caller_capability_profile"]
): TextMcpConsumerExecution {
  return {
    ...baseExecution(config, hostSetup, loop.modelWork, profile), live_surface: surface,
    consumer_model_calls: loop.modelCalls, mcp_dispatches: loop.mcpDispatches,
    events: loop.events, terminal: loop.terminal
  };
}

function emptyExecution(
  config: SemanticChainConfig, terminal: TextMcpConsumerTerminal, hostSetup: boolean,
  modelWork: TextMcpModelWorkStatus,
  profile?: TextMcpConsumerInput["caller_capability_profile"]
): TextMcpConsumerExecution {
  return {
    ...baseExecution(config, hostSetup, modelWork, profile), live_surface: null, consumer_model_calls: 0,
    mcp_dispatches: 0, events: [], terminal
  };
}

function baseExecution(
  config: SemanticChainConfig, hostSetup: boolean, modelWork: TextMcpModelWorkStatus,
  profile?: TextMcpConsumerInput["caller_capability_profile"]
) {
  return {
    contract: TEXT_MCP_CONSUMER_CONTRACT, consumer_kind: "text_mediated_mcp" as const, model_kind: "scripted" as const,
    claims: {
      native_provider_tool_calling: false as const, cli_host_equivalence: false as const,
      answer_quality: "not_verified" as const
    },
    paid_readiness: { ...TEXT_MCP_CONSUMER_PAID_READINESS },
    diagnostic_restriction: TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION,
    host_setup: hostSetup, original_snapshot_sha256: config.snapshot_sha256,
    model_work: { status: modelWork, wall_ms_meaning: TEXT_MCP_WALL_MS_MEANING },
    ...(profile === undefined ? {} : { caller_capability_profile: profile })
  };
}

function freezeExecution(value: TextMcpConsumerExecution): TextMcpConsumerExecution {
  return TextMcpConsumerExecutionSchema.parse(JSON.parse(JSON.stringify(value)));
}
