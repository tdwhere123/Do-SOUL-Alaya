import { resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import type { CompileSeedExtractionConfig, BenchSignalExtractor } from "../../compile-seed/compile-seed-types.js";
import { createSemanticProviderHttpExtractor } from "../../compile-seed/http/semantic-provider-http.js";
import { bindSemanticProviderRequest } from "../../provider-request/request-binding.js";
import { acquireExtractionCacheWriteLease } from "../../extraction/fill/manifest/fill-root-guard.js";
import { executeProviderRequestLine, replayExistingProviderRequestRaws,
  type ProviderRequestLine, type ProviderRequestPhysicalContext } from "../../provider-request/execution.js";
import { currentBenchScope, refuseBenchWorkAfterCancel, trackBenchOperation } from "../../../harness/daemon-task.js";
import type { BenchDaemonHandle } from "../../../harness/daemon.js";
import { SemanticChainConfigSchema, withSemanticChainDaemon, type SemanticChainConfig } from "../contract.js";
import { buildOrdinaryRecallRequest, mapOrdinaryRecallScope } from "../ordinary/ordinary-entry-contract.js";
import { TEXT_MCP_ACTION_SCHEMA_NAME } from "./codec.js";
import { TextMcpCeilingsSchema, TextMcpConsumerQuerySchema, TextMcpLiveSurfaceSchema,
  isUnresolvedTextMcpDelivery } from "./contract.js";
import { assertTextMcpOutputRoot, dispatchTextMcpRead, snapshotLiveMcpSurface } from "./live-mcp.js";
import {
  TEXT_MCP_PROVIDER_BOUND_KIND, TEXT_MCP_PROVIDER_SESSION_CONTRACT,
  assertTextMcpProviderSessionConsumer, assertTextMcpProviderSessionScope, check, readTextMcpProviderSessionGrant,
  type TextMcpProviderSessionGrant, type TextMcpProviderSessionPin
} from "./session-authority.js";
import {
  admitTextMcpProviderSessionRequest, listAdmittedSessionRequests, materializeTextMcpProviderSessionRequest,
  persistSessionTranscript, readSessionTranscript, type TextMcpProviderSessionLine
} from "./session-request.js";
import {
  interpretTextMcpProviderSession, openTextMcpProviderSessionLedger, publishTextMcpProviderSessionTurn,
  readTextMcpProviderSessionResult, assertSessionRaw
} from "./session-persist.js";

export type TextMcpProviderSessionDependencies = Readonly<{
  loadConfig: () => CompileSeedExtractionConfig;
  createExtractor?: (config: CompileSeedExtractionConfig) => BenchSignalExtractor;
}>;

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const SessionAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), tool: z.enum(["soul.recall", "soul.open_pointer"]),
    arguments: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("answer"), text: z.string() }).strict()
]);
/** invocations_this_invocation: model-work entries started in this consume, including raw replay.
 * attempts_this_invocation: physical reservations created under this consume's write lease.
 * mcp_dispatches: host_setup/mcp_call dispatches started in this consume, not prior transcript history.
 * host_setup: a recorded host-setup dispatch; response_state, not this flag, establishes delivery. */
const Result = z.object({
  contract: z.literal(TEXT_MCP_PROVIDER_SESSION_CONTRACT),
  model_kind: z.literal(TEXT_MCP_PROVIDER_BOUND_KIND),
  session_id: z.string().min(1),
  mode: z.enum(["execute", "recover"]),
  failure: z.string().nullable(),
  invocations_this_invocation: z.number().int().nonnegative(),
  attempts_this_invocation: z.number().int().nonnegative(),
  mcp_dispatches: z.number().int().nonnegative(),
  host_setup: z.boolean(),
  live_surface: TextMcpLiveSurfaceSchema.nullable(),
  events: z.array(z.record(z.string(), z.unknown())),
  turns: z.array(z.object({
    turn: z.number().int().positive(), key: Digest, request_digest: Digest, status: z.string(), terminal: z.unknown().optional()
  }).strict()),
  claims: z.object({
    native_provider_tool_calling: z.literal(false),
    scripted_complete_callback: z.literal(false),
    answer_quality: z.literal("not_verified")
  }).strict(),
  ledger: z.unknown(),
  cost: z.object({
    reported_input_tokens: z.number(), reported_output_tokens: z.number(), unknown_usage_attempts: z.number(),
    reserved_upper_usd: z.number(), invoice_usd: z.null()
  }).strict()
}).strict();
export type TextMcpProviderSessionResult = z.infer<typeof Result>;

type SessionConsumer = Readonly<{
  config: SemanticChainConfig;
  root: string;
  query: z.infer<typeof TextMcpConsumerQuerySchema>;
  host_issued_initial_recall: boolean;
  ceilings: z.infer<typeof TextMcpCeilingsSchema>;
}>;

/** Provider-bound session. Scripted complete() is not an argument and cannot gain remote authority. */
export async function consumeTextMcpProviderSession(input: Readonly<{
  grantPin: TextMcpProviderSessionPin;
  mode: "execute" | "recover";
  consumer?: unknown;
  abortSignal?: AbortSignal;
}>, dependencies: TextMcpProviderSessionDependencies) {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const pin = Object.freeze({ path: resolve(input.grantPin.path), sha256: input.grantPin.sha256 });
  const grant = readTextMcpProviderSessionGrant(pin), mode = input.mode, abortSignal = input.abortSignal;
  const admitted = listAdmittedSessionRequests(grant.execution_root);
  assertTextMcpProviderSessionScope(grant, admitted.map(line => line.key));
  const config: CompileSeedExtractionConfig = Object.freeze(structuredClone(mode === "recover"
    ? { model: grant.model, requestProfile: grant.request_profile, providerUrl: grant.provider_url, apiKey: null }
    : dependencies.loadConfig()) as CompileSeedExtractionConfig);
  if (config.model !== grant.model || config.requestProfile !== grant.request_profile || config.providerUrl !== grant.provider_url ||
    config.transportModel !== undefined || config.transportProviderUrl !== undefined) {
    throw new AlayaError("CONFLICT", "session config differs from externally granted route");
  }
  const consumer = mode === "execute" ? parseConsumer(input.consumer, grant) : undefined;
  const extractor = mode === "recover" ? undefined : dependencies.createExtractor?.(config) ??
    createSemanticProviderHttpExtractor(config, TEXT_MCP_ACTION_SCHEMA_NAME);
  const lease = acquireExtractionCacheWriteLease(grant.execution_root);
  try {
    const lines = listAdmittedSessionRequests(grant.execution_root);
    assertTextMcpProviderSessionScope(grant, lines.map(line => line.key), lease);
    const root = lease.stableRootPath, ledger = openTextMcpProviderSessionLedger(root, grant, lines);
    const baselineAttempts = ledger.snapshot().attempts;
    const stored = readSessionTranscript(root);
    const work: SessionWork = {
      surface: stored?.live_surface ?? null,
      events: stored?.events.slice() ?? [],
      hostSetup: stored?.host_setup ?? false,
      mcpDispatches: 0,
      invocations: 0
    };
    const priorMcp = work.events.filter(event => event.kind === "mcp_call" || event.kind === "host_setup").length;
    const byKey = new Map(lines.map(line => [line.key, line]));
    const context: ProviderRequestPhysicalContext = { cacheRoot: root, model: grant.model, requestProfile: grant.request_profile,
      attemptLineageDigest: grant.lineage, maxOutputTokens: grant.limits.max_output_tokens, maximumAttemptsPerKey: 1, ledger,
      assertReservation: raw => assertSessionRaw(raw, grant, byKey.get(raw.cache_key)!, ledger.snapshot()),
      interpretDecoded: (line, decoded) => interpretTextMcpProviderSession(byKey.get(line.key)!, decoded, grant.limits.max_output_bytes),
      publishArtifact: published => publishTextMcpProviderSessionTurn(root, grant, published) };
    let failure: string | null = null;
    try {
      if (mode === "recover") {
        for (const line of lines) replayExistingProviderRequestRaws(context, toProviderLine(line));
      } else {
        await runProviderSessionExecute({
          grant, pin, config, consumer: consumer!, extractor: extractor!, lease, context, lines, byKey,
          suppliedExtractor: dependencies.createExtractor !== undefined, abortSignal, priorMcp
        }, work);
      }
    } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
    const snapshot = ledger.snapshot();
    return Result.parse({
      contract: TEXT_MCP_PROVIDER_SESSION_CONTRACT, model_kind: TEXT_MCP_PROVIDER_BOUND_KIND,
      session_id: grant.session_id, mode, failure,
      invocations_this_invocation: work.invocations, attempts_this_invocation: snapshot.attempts - baselineAttempts,
      mcp_dispatches: work.mcpDispatches, host_setup: work.hostSetup, live_surface: work.surface, events: work.events,
      turns: lines.map(line => {
        const result = readTextMcpProviderSessionResult(root, grant, line);
        return { turn: line.turn, key: line.key, request_digest: line.request_digest, status: result.status,
          ...(result.terminal === undefined ? {} : { terminal: result.terminal }) };
      }),
      claims: { native_provider_tool_calling: false, scripted_complete_callback: false, answer_quality: "not_verified" },
      ledger: snapshot,
      cost: { reported_input_tokens: snapshot.telemetry.inputTokens, reported_output_tokens: snapshot.telemetry.outputTokens,
        unknown_usage_attempts: snapshot.telemetry.usageUnknownAttempts, reserved_upper_usd: grant.limits.spend_ceiling_usd,
        invoice_usd: null }
    });
  } finally { lease.release(); }
}

function parseConsumer(value: unknown, grant: TextMcpProviderSessionGrant): SessionConsumer {
  const raw = z.object({
    config: z.unknown(), root: z.string().min(1), query: TextMcpConsumerQuerySchema,
    host_issued_initial_recall: z.boolean(), ceilings: TextMcpCeilingsSchema
  }).strict().parse(structuredClone(value));
  const config = SemanticChainConfigSchema.parse(structuredClone(raw.config));
  assertTextMcpOutputRoot(raw.root, config);
  assertTextMcpProviderSessionConsumer(grant, {
    snapshot_sha256: config.snapshot_sha256,
    query: { query_key: raw.query.query_key, original_query: raw.query.original_query },
    host_issued_initial_recall: raw.host_issued_initial_recall,
    ceilings: raw.ceilings
  });
  return { ...raw, config };
}

async function runProviderSessionExecute(input: Readonly<{
  grant: TextMcpProviderSessionGrant; pin: TextMcpProviderSessionPin; config: CompileSeedExtractionConfig;
  consumer: SessionConsumer; extractor: BenchSignalExtractor;
  lease: ReturnType<typeof acquireExtractionCacheWriteLease>;
  context: ProviderRequestPhysicalContext; lines: TextMcpProviderSessionLine[];
  byKey: Map<string, TextMcpProviderSessionLine>; suppliedExtractor: boolean; abortSignal?: AbortSignal;
  priorMcp: number;
}>, work: SessionWork) {
  throwIfSessionCancelled(input.abortSignal);
  const scope = currentBenchScope();
  const operation = async () => {
    refuseBenchWorkAfterCancel();
    throwIfSessionCancelled(input.abortSignal);
    return withSemanticChainDaemon(input.consumer.config, input.consumer.root, async daemon => {
      refuseBenchWorkAfterCancel();
      throwIfSessionCancelled(input.abortSignal);
      const live = await snapshotLiveMcpSurface(daemon.mcpClient);
      throwIfSessionCancelled(input.abortSignal);
      const stored = readSessionTranscript(input.grant.execution_root);
      if (stored !== undefined) check(canonicalJson(stored.live_surface) === canonicalJson(live), "session live surface drifted");
      work.surface = stored?.live_surface ?? live;
      if (stored !== undefined) {
        work.events = stored.events.slice();
        work.hostSetup = stored.host_setup;
      }
      const persist = () => persistSessionTranscript(input.grant.execution_root, input.grant, {
        contract: "text-mcp-provider-session-transcript-v1", live_surface: work.surface!,
        query: input.grant.query.original_query, host_setup: work.hostSetup, events: work.events
      });
      persist();
      if (unresolvedEvent(work.events, "host_setup")) return;
      await ensureHostSetup(input.grant, input.consumer, daemon, work, persist, input.abortSignal, input.priorMcp);
      if (unresolvedEvent(work.events, "host_setup")) return;
      throwIfSessionCancelled(input.abortSignal);
      const phaseDeadlineMs = performance.now() + input.grant.limits.wall_ms;
      for (const line of input.lines.slice()) {
        if (await settleSessionTurn(input, daemon, line, work, persist, phaseDeadlineMs) !== "continue") return;
      }
      while (input.lines.length < input.grant.limits.max_model_turns) {
        throwIfSessionCancelled(input.abortSignal);
        const snapshot = input.context.ledger.snapshot();
        if (snapshot.telemetry.usageUnknownAttempts > 0 || snapshot.unresolvedAttempts.length > 0) break;
        if (performance.now() >= phaseDeadlineMs) break;
        const derived = materializeTextMcpProviderSessionRequest({
          grant: input.grant, config: input.config, surface: work.surface!,
          query: input.grant.query.original_query, events: work.events
        });
        const admitted = admitTextMcpProviderSessionRequest(input.grant.execution_root, input.grant, input.lines.length + 1, derived);
        if (!input.lines.some(line => line.turn === admitted.turn)) input.lines.push(admitted);
        input.byKey.set(admitted.key, admitted);
        if (await settleSessionTurn(input, daemon, admitted, work, persist, phaseDeadlineMs) !== "continue") break;
      }
    });
  };
  return scope === undefined ? operation() : trackBenchOperation(scope, operation);
}

async function ensureHostSetup(grant: TextMcpProviderSessionGrant, consumer: SessionConsumer, daemon: BenchDaemonHandle,
  work: SessionWork, persist: () => void, abortSignal: AbortSignal | undefined, priorMcp: number) {
  throwIfSessionCancelled(abortSignal);
  if (!grant.host_issued_initial_recall || work.events.some(event => event.kind === "host_setup")) return;
  const mapping = mapOrdinaryRecallScope(consumer.config.authorized_scopes);
  if (mapping.status !== "mapped" || priorMcp + work.mcpDispatches >= grant.limits.max_tool_calls) return;
  const args = structuredClone(buildOrdinaryRecallRequest({
    query: consumer.query.original_query, scope_class: mapping.scope_class,
    source_observed_at: consumer.config.interpretation_clock,
    ...(consumer.query.interpretation_proposal === undefined
      ? {} : { interpretation_proposal: consumer.query.interpretation_proposal })
  }));
  throwIfSessionCancelled(abortSignal);
  reserveMcpDelivery(work, persist, {
    kind: "host_setup", generated_by: "host_controlled_setup", tool: "soul.recall", arguments: args
  });
  const dispatched = await dispatchReservedMcp(work, persist, () => dispatchTextMcpRead(daemon.mcpClient, "soul.recall", args));
  if (isUnresolvedTextMcpDelivery(dispatched.response_state)) return;
}

async function settleSessionTurn(input: Parameters<typeof runProviderSessionExecute>[0], daemon: BenchDaemonHandle,
  line: TextMcpProviderSessionLine, work: SessionWork, persist: () => void, phaseDeadlineMs: number) {
  throwIfSessionCancelled(input.abortSignal);
  const snapshot = input.context.ledger.snapshot();
  if (snapshot.telemetry.usageUnknownAttempts > 0 || snapshot.unresolvedAttempts.length > 0) return "stop";
  work.invocations += 1;
  const result = await executeProviderRequestLine({
    ...input.context, config: input.config, extractor: input.extractor, writeLease: input.lease,
    suppliedExtractor: input.suppliedExtractor, phaseDeadlineMs,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    assertScope: () => assertSessionDispatch(input, line)
  }, toProviderLine(line));
  const read = readTextMcpProviderSessionResult(input.grant.execution_root, input.grant, line);
  if (!work.events.some(event => event.kind === "model_turn" && event.key === line.key)) {
    work.events.push({
      kind: "model_turn", key: line.key, request_digest: line.request_digest,
      model_text: read.terminal?.raw_json ?? null, finishReason: read.terminal?.finish_reason ?? null,
      decoded: read.terminal?.outcome ?? null
    });
    persist();
  }
  throwIfSessionCancelled(input.abortSignal);
  if (performance.now() >= phaseDeadlineMs) return "stop";
  if (!result.admitted) return "stop";
  const action = readSessionAction(read.terminal?.outcome);
  if (action?.kind === "answer") return "answered";
  if (action?.kind !== "read") return "stop";
  const follow = mcpFollowupFor(work.events, line.key);
  if (follow === "unresolved") return "stop";
  if (follow === "settled") return "continue";
  if (input.priorMcp + work.mcpDispatches >= input.grant.limits.max_tool_calls) return "stop";
  throwIfSessionCancelled(input.abortSignal);
  if (performance.now() >= phaseDeadlineMs) return "stop";
  const args = structuredClone(action.arguments);
  reserveMcpDelivery(work, persist, {
    kind: "mcp_call", origin: "model_selected", tool: action.tool, arguments: args
  });
  const dispatched = await dispatchReservedMcp(work, persist, () => dispatchTextMcpRead(daemon.mcpClient, action.tool, args));
  return isUnresolvedTextMcpDelivery(dispatched.response_state) ? "stop" : "continue";
}

function assertSessionDispatch(input: Parameters<typeof runProviderSessionExecute>[0], line: TextMcpProviderSessionLine) {
  readTextMcpProviderSessionGrant(input.pin);
  assertTextMcpProviderSessionScope(input.grant, input.lines.map(item => item.key), input.lease);
  const binding = bindSemanticProviderRequest(input.config, {
    systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, responseJsonSchema: line.responseJsonSchema,
    maxOutputTokens: input.grant.limits.max_output_tokens
  }, TEXT_MCP_ACTION_SCHEMA_NAME);
  if (binding.requestDigest !== line.request_digest ||
    canonicalJson(binding.transportProvenance) !== canonicalJson(line.transportProvenance)) {
    throw new AlayaError("CONFLICT", "session request changed before dispatch");
  }
}

function toProviderLine(line: TextMcpProviderSessionLine): ProviderRequestLine {
  return {
    key: line.key, kind: "task_consumer", systemPrompt: line.systemPrompt, userPrompt: line.userPrompt,
    responseJsonSchema: line.responseJsonSchema, requestDigest: line.request_digest, inputByteUpper: line.inputByteUpper
  };
}

function readSessionAction(outcome: unknown) {
  const parsed = z.object({ action: SessionAction }).passthrough().safeParse(outcome);
  return parsed.success ? parsed.data.action : undefined;
}

function reserveMcpDelivery(work: SessionWork, persist: () => void, event: Record<string, unknown>): void {
  const reserved = { ...event, response_state: "unknown", envelope: null };
  const priorHostSetup = work.hostSetup;
  work.events.push(reserved);
  if (event.kind === "host_setup") work.hostSetup = true;
  try { persist(); }
  catch (cause) {
    work.events.pop();
    work.hostSetup = priorHostSetup;
    throw cause;
  }
  work.mcpDispatches += 1;
}

async function dispatchReservedMcp(work: SessionWork, persist: () => void, run: () => Promise<{
  tool: string; arguments: Record<string, unknown>; response_state: string; envelope: unknown;
}>) {
  const last = work.events[work.events.length - 1];
  const dispatched = await run();
  if (last === undefined) return dispatched;
  const previousState = last.response_state, previousEnvelope = last.envelope;
  last.tool = dispatched.tool;
  last.arguments = dispatched.arguments;
  last.response_state = dispatched.response_state;
  last.envelope = dispatched.envelope;
  try { persist(); }
  catch (cause) {
    last.response_state = previousState;
    last.envelope = previousEnvelope;
    throw cause;
  }
  return dispatched;
}

function mcpFollowupFor(events: readonly Record<string, unknown>[], key: string): "none" | "settled" | "unresolved" {
  const index = events.findIndex(event => event.kind === "model_turn" && event.key === key);
  if (index < 0) return "none";
  const later = events.slice(index + 1);
  const nextModel = later.findIndex(event => event.kind === "model_turn");
  const window = nextModel < 0 ? later : later.slice(0, nextModel);
  const call = window.find(event => event.kind === "mcp_call");
  if (call === undefined) return "none";
  return isUnresolvedTextMcpDelivery(call.response_state) ? "unresolved" : "settled";
}

function unresolvedEvent(events: readonly Record<string, unknown>[], kind: "host_setup"): boolean {
  const event = events.find(item => item.kind === kind);
  return event !== undefined && isUnresolvedTextMcpDelivery(event.response_state);
}

function throwIfSessionCancelled(signal?: AbortSignal) {
  refuseBenchWorkAfterCancel();
  if (signal?.aborted === true) {
    throw new AlayaError("CANCELLED", "provider session was cancelled before new work could start");
  }
}

type SessionWork = {
  surface: z.infer<typeof TextMcpLiveSurfaceSchema> | null;
  events: Record<string, unknown>[];
  hostSetup: boolean;
  mcpDispatches: number;
  invocations: number;
};
