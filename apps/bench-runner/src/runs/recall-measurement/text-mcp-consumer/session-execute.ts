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
import { TextMcpCeilingsSchema, TextMcpConsumerQuerySchema, TextMcpLiveSurfaceSchema } from "./contract.js";
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
  const initial = assertTextMcpProviderSessionScope(grant, admitted.map(line => line.key));
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
    const byKey = new Map(lines.map(line => [line.key, line]));
    const context: ProviderRequestPhysicalContext = { cacheRoot: root, model: grant.model, requestProfile: grant.request_profile,
      attemptLineageDigest: grant.lineage, maxOutputTokens: grant.limits.max_output_tokens, maximumAttemptsPerKey: 1, ledger,
      assertReservation: raw => assertSessionRaw(raw, grant, byKey.get(raw.cache_key)!, ledger.snapshot()),
      interpretDecoded: (line, decoded) => interpretTextMcpProviderSession(byKey.get(line.key)!, decoded, grant.limits.max_output_bytes),
      publishArtifact: published => publishTextMcpProviderSessionTurn(root, grant, published) };
    let failure: string | null = null, invocations = 0, mcpDispatches = 0, hostSetup = false;
    let surface = readSessionTranscript(root)?.live_surface ?? null;
    let events: Record<string, unknown>[] = readSessionTranscript(root)?.events.slice() ?? [];
    try {
      if (mode === "recover") {
        for (const line of lines) replayExistingProviderRequestRaws(context, toProviderLine(line));
      } else {
        const ran = await runProviderSessionExecute({
          grant, pin, config, consumer: consumer!, extractor: extractor!, lease, context, lines, byKey,
          suppliedExtractor: dependencies.createExtractor !== undefined, abortSignal
        });
        invocations = ran.invocations; mcpDispatches = ran.mcpDispatches; hostSetup = ran.hostSetup;
        surface = ran.surface; events = ran.events;
      }
    } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
    const snapshot = ledger.snapshot();
    return Result.parse({
      contract: TEXT_MCP_PROVIDER_SESSION_CONTRACT, model_kind: TEXT_MCP_PROVIDER_BOUND_KIND,
      session_id: grant.session_id, mode, failure,
      invocations_this_invocation: invocations, attempts_this_invocation: snapshot.attempts - initial.attempts,
      mcp_dispatches: mcpDispatches, host_setup: hostSetup, live_surface: surface, events,
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
}>) {
  const scope = currentBenchScope();
  const operation = async () => {
    refuseBenchWorkAfterCancel();
    return withSemanticChainDaemon(input.consumer.config, input.consumer.root, async daemon => {
      refuseBenchWorkAfterCancel();
      const live = await snapshotLiveMcpSurface(daemon.mcpClient);
      const stored = readSessionTranscript(input.grant.execution_root);
      if (stored !== undefined) check(canonicalJson(stored.live_surface) === canonicalJson(live), "session live surface drifted");
      const work = {
        surface: stored?.live_surface ?? live,
        events: stored?.events.slice() ?? [],
        hostSetup: stored?.host_setup ?? false,
        mcpDispatches: 0,
        invocations: 0
      };
      work.mcpDispatches = work.events.filter(event => event.kind === "mcp_call" || event.kind === "host_setup").length;
      const persist = () => persistSessionTranscript(input.grant.execution_root, input.grant, {
        contract: "text-mcp-provider-session-transcript-v1", live_surface: work.surface,
        query: input.grant.query.original_query, host_setup: work.hostSetup, events: work.events
      });
      persist();
      await ensureHostSetup(input.grant, input.consumer, daemon, work, persist);
      const phaseDeadlineMs = performance.now() + input.grant.limits.wall_ms;
      for (const line of input.lines.slice()) {
        if (await settleSessionTurn(input, daemon, line, work, persist, phaseDeadlineMs) !== "continue") {
          return sessionWorkResult(work);
        }
      }
      while (input.lines.length < input.grant.limits.max_model_turns) {
        refuseBenchWorkAfterCancel();
        const snapshot = input.context.ledger.snapshot();
        if (snapshot.telemetry.usageUnknownAttempts > 0 || snapshot.unresolvedAttempts.length > 0) break;
        if (performance.now() >= phaseDeadlineMs) break;
        const derived = materializeTextMcpProviderSessionRequest({
          grant: input.grant, config: input.config, surface: work.surface,
          query: input.grant.query.original_query, events: work.events
        });
        const admitted = admitTextMcpProviderSessionRequest(input.grant.execution_root, input.grant, input.lines.length + 1, derived);
        if (!input.lines.some(line => line.turn === admitted.turn)) input.lines.push(admitted);
        input.byKey.set(admitted.key, admitted);
        if (await settleSessionTurn(input, daemon, admitted, work, persist, phaseDeadlineMs) !== "continue") break;
      }
      return sessionWorkResult(work);
    });
  };
  return scope === undefined ? operation() : trackBenchOperation(scope, operation);
}

async function ensureHostSetup(grant: TextMcpProviderSessionGrant, consumer: SessionConsumer, daemon: BenchDaemonHandle,
  work: SessionWork, persist: () => void) {
  if (!grant.host_issued_initial_recall || work.events.some(event => event.kind === "host_setup")) return;
  const mapping = mapOrdinaryRecallScope(consumer.config.authorized_scopes);
  if (mapping.status !== "mapped" || work.mcpDispatches >= grant.limits.max_tool_calls) return;
  const args = structuredClone(buildOrdinaryRecallRequest({
    query: consumer.query.original_query, scope_class: mapping.scope_class,
    source_observed_at: consumer.config.interpretation_clock,
    ...(consumer.query.interpretation_proposal === undefined
      ? {} : { interpretation_proposal: consumer.query.interpretation_proposal })
  }));
  const dispatched = await dispatchTextMcpRead(daemon.mcpClient, "soul.recall", args);
  work.mcpDispatches += 1; work.hostSetup = true;
  work.events.push({
    kind: "host_setup", generated_by: "host_controlled_setup", tool: dispatched.tool,
    arguments: dispatched.arguments, response_state: dispatched.response_state, envelope: dispatched.envelope
  });
  persist();
}

async function settleSessionTurn(input: Parameters<typeof runProviderSessionExecute>[0], daemon: BenchDaemonHandle,
  line: TextMcpProviderSessionLine, work: SessionWork, persist: () => void, phaseDeadlineMs: number) {
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
  if (!result.admitted) return "stop";
  const action = readSessionAction(read.terminal?.outcome);
  if (action?.kind === "answer") return "answered";
  if (action?.kind !== "read") return "stop";
  if (hasMcpAfter(work.events, line.key)) return "continue";
  if (work.mcpDispatches >= input.grant.limits.max_tool_calls) return "stop";
  const dispatched = await dispatchTextMcpRead(daemon.mcpClient, action.tool, structuredClone(action.arguments));
  work.mcpDispatches += 1;
  work.events.push({
    kind: "mcp_call", origin: "model_selected", tool: dispatched.tool, arguments: dispatched.arguments,
    response_state: dispatched.response_state, envelope: dispatched.envelope
  });
  persist();
  if (dispatched.response_state === "transport_error" || dispatched.response_state === "unknown"
    || dispatched.response_state === "invalid_response") return "stop";
  return "continue";
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

function hasMcpAfter(events: readonly Record<string, unknown>[], key: string): boolean {
  const index = events.findIndex(event => event.kind === "model_turn" && event.key === key);
  return index >= 0 && events.slice(index + 1).some(event => event.kind === "mcp_call");
}

function sessionWorkResult(work: SessionWork) {
  return { invocations: work.invocations, mcpDispatches: work.mcpDispatches, hostSetup: work.hostSetup,
    surface: work.surface, events: work.events };
}

type SessionWork = {
  surface: z.infer<typeof TextMcpLiveSurfaceSchema>;
  events: Record<string, unknown>[];
  hostSetup: boolean;
  mcpDispatches: number;
  invocations: number;
};
