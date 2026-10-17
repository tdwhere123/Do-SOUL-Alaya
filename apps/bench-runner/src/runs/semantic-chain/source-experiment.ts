import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AlayaError, canonicalJson, SourceSemanticInterpretationSchema, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { admitSourceSemanticCorrespondence, createSourceFeedbackSession,
  type SourceFeedbackSessionInput } from "@do-soul/alaya-core";
import { assertChainSnapshot, chainIdentity, readChainArtifact, SemanticChainConfigSchema,
  withSemanticChainDaemon, writeChainArtifact, type SemanticChainConfig } from "./contract.js";
import { readRecoveryAction, recoveryAllowanceIdentity, reserveRecoveryAction, reserveRecoveryRead } from "./recovery-allowance.js";
import { createSourceFeedbackCorrespondenceCache,
  type SourceFeedbackCachePolicy } from "./source-feedback-correspondence-cache.js";
import { currentBenchScope } from "../../harness/daemon-task.js";
import { readSemanticProposalResults } from "../semantic-proposal/fill.js";
import { materializeSemanticProposalLines, type SemanticProposalWorkset } from "../semantic-proposal/workset.js";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import type { SourceFeedbackRuntimeInput } from "../../../../core-daemon/src/runtime/recall/source-feedback-execution.js";

type FeedbackTrace = ReturnType<ReturnType<typeof createSourceFeedbackSession>["finish"]>;
// Shared with the retained one-shot daemon admission: modes cannot compete under different names.
const ACTION = "initial-reason-daemon";
export type SourceFeedbackExperimentInput = Readonly<{
  contract: "source-feedback-experiment-v1";
  config: SemanticChainConfig;
  session: SourceFeedbackSessionInput;
  context: SourceFeedbackRuntimeInput["context"];
  seed_interpretation: unknown;
  correspondence: SourceFeedbackCachePolicy;
  timeout_ms: number;
  /** Named consumer's captured projection inputs, never an execution callback or another seed. */
  legacy?: { window_identity: string; qualified_snapshot_identity: string; proposal_status: string; source_window: unknown[] };
  seed_cache: { key: string; cache_identity: string; historical_production: unknown;
    workset: SemanticProposalWorkset; cache_root: string; max_output_tokens: number };
}>;
type Execution = { identity: string; trace: FeedbackTrace };
type Lifetime = { identity: string; status: "closed" | "failed";
  phase: "startup" | "feedback" | "cleanup"; diagnostic?: unknown };

/** JSON persistence owns diagnostics too: Error, cycles and non-JSON abort reasons cannot vanish.
 * Normal optional undefined fields are absent; diagnostic values retain an explicit tagged form. */
export function captureSourceExperimentValue(value: unknown, diagnostic = false): unknown {
  const seen = new Set<object>();
  let diagnosticNodes = 0;
  function capture(item: unknown, depth: number, diagnostic = false): unknown {
    if (diagnostic && ++diagnosticNodes > 8192) return { diagnostic_type: "capture_limit" };
    if (typeof item === "string" && diagnostic && item.length > 65536) return { diagnostic_type: "truncated_string", prefix: item.slice(0, 65536), length: item.length };
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : { diagnostic_type: "number", value: String(item) };
    if (typeof item !== "object") return { diagnostic_type: typeof item, value: String(item) };
    if (depth > 64 || seen.has(item)) return { diagnostic_type: depth > 64 ? "depth_limit" : "circular" };
    seen.add(item);
    try {
      if (Array.isArray(item)) return diagnostic && item.length > 256
        ? { diagnostic_type: "truncated_array", length: item.length, prefix: item.slice(0, 256).map(entry => capture(entry, depth + 1, true)) }
        : item.map(entry => capture(entry, depth + 1, diagnostic));
      if (item instanceof Date) return { diagnostic_type: "date", value: item.toISOString() };
      if (item instanceof Map || item instanceof Set) {
        const entries: unknown[] = [];
        for (const entry of item) { if (entries.length === 256) break; entries.push(capture(entry, depth + 1, true)); }
        return { diagnostic_type: item instanceof Map ? "map" : "set", entries, size: item.size, truncated: item.size > entries.length };
      }
      const output: Record<string, unknown> = {};
      const keys = new Set(Object.keys(item));
      if (item instanceof Error) for (const key of ["name", "message", "stack", "cause", "code", "subCode"]) keys.add(key);
      for (const key of keys) {
        if (diagnostic && Object.keys(output).length === 256) {
          return { diagnostic_type: "truncated_object", field_count: keys.size, fields: output };
        }
        try {
          const entry = Reflect.get(item, key);
          if (entry === undefined && !diagnostic && !(item instanceof Error)) continue;
          Object.defineProperty(output, key, { enumerable: true, value: capture(entry, depth + 1,
            diagnostic || key === "terminal_cause" || key === "diagnostic" || item instanceof Error) });
        } catch { Object.defineProperty(output, key, { enumerable: true, value: { diagnostic_type: "unavailable" } }); }
      }
      return output;
    } catch { return { diagnostic_type: "unavailable" }; }
    finally { seen.delete(item); }
  }
  return capture(value, 0, diagnostic);
}

/** Readback only. In particular, no cache readiness, snapshot hash, worker startup or reservation. */
export function readSourceExperiment(rootInput: string) {
  const root = resolve(rootInput);
  const input = readChainArtifact(join(root, "source-experiment-input.json")) as SourceFeedbackExperimentInput | undefined;
  const execution = readChainArtifact(join(root, "source-experiment-result.json")) as Execution | undefined;
  const lifetime = readChainArtifact(join(root, "source-experiment-lifetime.json")) as Lifetime | undefined;
  const projection = readChainArtifact(join(root, "source-experiment-projection.json")) as { identity: string } | undefined;
  const reservation = existsSync(join(root, "recovery-allowance.sqlite")) ? readRecoveryAction(root, ACTION) : undefined;
  const identity = input === undefined ? undefined : chainIdentity(input);
  if ((execution !== undefined || lifetime !== undefined || projection !== undefined) && input === undefined ||
      execution !== undefined && (execution.identity !== identity || reservation === undefined) ||
      lifetime !== undefined && lifetime.identity !== identity || projection !== undefined && (projection.identity !== identity || execution === undefined) ||
      reservation !== undefined && input !== undefined && (reservation.identity !== identity || reservation.work_units !== input.session.budget.work_units ||
        reservation.memory_bytes !== input.session.budget.memory_bytes)) {
    throw new AlayaError("CONFLICT", "source experiment durable authorities disagree");
  }
  return { status: execution !== undefined ? projection === undefined ? "result_ready" as const : "complete" as const
      : reservation === undefined ? "not_started" as const : "unsettled_unknown" as const,
    identity, input, execution, lifetime: lifetime ?? { status: reservation === undefined ? "not_started" as const : "unknown" as const }, projection };
}

function admitExperiment(input: SourceFeedbackExperimentInput, root: string): void {
  if (input.contract !== "source-feedback-experiment-v1" || !Number.isSafeInteger(input.timeout_ms) ||
      input.timeout_ms <= 0 || input.timeout_ms > 600_000) throw new AlayaError("VALIDATION", "unsupported feedback experiment policy");
  const recoveryWindow = readChainArtifact(join(root, "recovery-window.json")) as { contract?: string; feedback?: unknown } | undefined;
  if (recoveryWindow !== undefined && (recoveryWindow.contract !== "source-semantic-recovery-feedback-window-v1" ||
      input.legacy?.window_identity !== chainIdentity(recoveryWindow) || canonicalJson(recoveryWindow.feedback) !== canonicalJson({
        execution_version: input.contract, budget: input.session.budget, action_budget: input.session.action_budget, timeout_ms: input.timeout_ms }))) {
    throw new AlayaError("CONFLICT", "reusable feedback cannot bypass the recovery root's frozen execution mode");
  }
  SemanticChainConfigSchema.parse(input.config);
  createSourceFeedbackSession(input.session); // Existing request/child allocation admission, without dispatch.
  const h = SourceSemanticInterpretationSchema.parse(input.seed_interpretation), seed = input.session.seed;
  if (seed.query_semantics === undefined || seed.semantic_correspondence === undefined) {
    throw new AlayaError("CONFLICT", "source experiment requires an admitted H/Q/C seed");
  }
  const admission = admitSourceSemanticCorrespondence({ source_interpretation: h,
    original_query: input.session.original_query, query_semantics: seed.query_semantics, semantic_correspondence: seed.semantic_correspondence });
  if (admission.kind !== "admitted" || admission.interpretation_id !== seed.source_interpretation_id ||
      h.source.source_id !== input.session.source_id || h.source.source_version !== input.session.source_target.source_version ||
      h.source.content_digest !== input.session.source_target.content_digest ||
      input.session.parent_entitlement_id !== recoveryAllowanceIdentity(root) ||
      input.context.workspace_id !== input.config.workspace_id || input.context.workspace_id !== input.session.workspace_id ||
      input.context.as_of !== input.config.interpretation_clock || input.context.as_of !== input.session.as_of ||
      input.session.scope_identity !== canonicalJson([input.context.principal ?? null, input.context.authorized_scopes]) ||
      canonicalJson(input.context.authorized_scopes) !== canonicalJson(input.config.authorized_scopes)) {
    throw new AlayaError("CONFLICT", "source experiment seed or parent authority changed");
  }
  const policy = createSourceFeedbackCorrespondenceCache(input.correspondence);
  if (policy.policy_id !== input.session.correspondence_policy_id ||
      input.session.budget.work_units < input.session.action_budget.work_units ||
      input.session.budget.memory_bytes < input.session.action_budget.memory_bytes) {
    throw new AlayaError("CONFLICT", "source experiment lacks its frozen cache or operation allowance");
  }
  const meter = new SourceSemanticResourceLedger(input.session.action_budget);
  meter.retain(input, "feedback frozen input admission");
  const retained = input.seed_cache;
  if (retained.workset.kind !== "semantic_correspondence" || retained.workset.items.length !== 1 ||
      retained.workset.revision_parent_cache_root !== undefined || resolve(retained.cache_root) !== resolve(input.correspondence.cache_root) ||
      retained.max_output_tokens !== input.correspondence.max_output_tokens) {
    throw new AlayaError("CONFLICT", "feedback seed lacks one bound physical workset/cache authority");
  }
  const line = materializeSemanticProposalLines(retained.workset, retained.max_output_tokens, meter)[0]!;
  const request = line.request as SourceSemanticCorrespondenceRequest;
  const { contract: _contract, kind: _kind, items: _items, ...producer } = retained.workset;
  if (request.revision !== undefined || line.key !== retained.key ||
      canonicalJson(producer) !== canonicalJson(input.correspondence.producer) ||
      canonicalJson(request.generation_policy) !== canonicalJson(input.correspondence.generation_policy) ||
      canonicalJson(request.admitted_query_semantics) !== canonicalJson(seed.query_semantics) || request.original_query !== input.session.original_query ||
      request.source_interpretation_descriptors[0]?.source_interpretation_id !== admission.interpretation_id ||
      canonicalJson(request.source_interpretation_descriptors[0]?.interpretation) !== canonicalJson(h)) {
    throw new AlayaError("CONFLICT", "feedback seed differs from its already bound request policy");
  }
  const row = readSemanticProposalResults(retained.workset, retained.cache_root, retained.max_output_tokens, meter)[0];
  if (row?.status !== "interpreted" || row.line.key !== input.seed_cache.key || row.shard === undefined ||
      chainIdentity(row.shard) !== input.seed_cache.cache_identity ||
      canonicalJson(input.seed_cache.historical_production) !== canonicalJson(row.shard.usage === undefined
        ? { status: "unknown" } : { status: "reported", usage: row.shard.usage }) || row.received === undefined ||
      !("semantic_correspondence" in row.received) || canonicalJson(row.received.semantic_correspondence) !== canonicalJson(seed.semantic_correspondence)) {
    throw new AlayaError("CONFLICT", "source experiment seed cache/request authority changed");
  }
  assertChainSnapshot(input.config);
}

/** One durable execution owner for the named private feedback experiment. No acquisition stub.
 * The numeric SQLite reservation is the sole execution claim. Lost results never authorize retry. */
export async function runSourceFeedbackExperiment(inputValue: SourceFeedbackExperimentInput, rootInput: string,
  options: Readonly<{ signal?: AbortSignal }> = {}) {
  const captured = structuredClone(inputValue), capturedOptions = { ...options }, signal = capturedOptions.signal, root = resolve(rootInput);
  if (Object.keys(capturedOptions).some(key => key !== "signal")) throw new AlayaError("VALIDATION", "unsupported source experiment options");
  const input = captureSourceExperimentValue(captured) as SourceFeedbackExperimentInput;
  const identity = chainIdentity(input), prior = readSourceExperiment(root);
  if (prior.input !== undefined && prior.identity !== identity) throw new AlayaError("CONFLICT", "source experiment input changed");
  if (prior.status !== "not_started") return prior;
  const blocked = (phase: "admission" | "reservation", error: unknown) => ({ ...prior, status: "blocked" as const,
    phase, execution_started: false as const, diagnostic: captureSourceExperimentValue(error, true) });
  let execution: typeof import("../../../../core-daemon/dist/runtime/recall/source-feedback-execution.js");
  try {
    signal?.throwIfAborted();
    reserveRecoveryRead(root, "admit bounded feedback experiment", [input.config.snapshot_path]);
    admitExperiment(input, root);
    // Match the constructor's compiled module identity, without starting a daemon.
    execution = await import("../../../../core-daemon/dist/runtime/recall/source-feedback-execution.js");
    if (typeof execution.executeSourceFeedbackForRuntime !== "function") throw new AlayaError("UNAVAILABLE", "feedback execution capability unavailable");
    const timing = await import("../../../../core-daemon/dist/runtime/recall-read-worker/client-config.js");
    if (input.timeout_ms > timing.normalizeRequestTimeoutMs(undefined)) {
      throw new AlayaError("CONFLICT", "worker execution-scope limit is below the frozen feedback timeout");
    }
    writeChainArtifact(join(root, "source-experiment-input.json"), input);
  } catch (error) { return blocked("admission", error); }
  // A competing process loses here, before snapshot copy, constructor or worker effects.
  try { reserveRecoveryAction(root, ACTION, identity, input.session.budget.work_units, input.session.budget.memory_bytes, false); }
  catch (error) { return blocked("reservation", error); }
  const started = performance.now();
  let phase: Lifetime["phase"] = "startup";
  try {
    await withSemanticChainDaemon(input.config, root, async daemon => {
      const scope = currentBenchScope();
      const signals = [signal, scope?.signal].filter((value): value is AbortSignal => value !== undefined);
      const linked = AbortSignal.any(signals);
      const remaining = Math.floor(input.timeout_ms - (performance.now() - started));
      if (remaining <= 0) throw new AlayaError("DEADLINE", "feedback lifetime exhausted during daemon startup");
      phase = "feedback";
      const trace = await execution.executeSourceFeedbackForRuntime(daemon.runtime, { session: input.session, context: input.context,
        correspondence: createSourceFeedbackCorrespondenceCache(input.correspondence), signal: linked, timeoutMs: remaining });
      // This is authoritative before shutdown. Failure in cleanup cannot erase it or reopen dispatch.
      writeChainArtifact(join(root, "source-experiment-result.json"), { identity, trace: captureSourceExperimentValue(trace) });
      phase = "cleanup";
    }, { signal, embeddingStartupProbe: "omit" });
    writeChainArtifact(join(root, "source-experiment-lifetime.json"), { identity, status: "closed", phase });
  } catch (error) {
    writeChainArtifact(join(root, "source-experiment-lifetime.json"), { identity, status: "failed", phase,
      diagnostic: captureSourceExperimentValue(error, true) });
  }
  return readSourceExperiment(root);
}
