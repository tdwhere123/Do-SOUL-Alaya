import {
  canonicalJson, sameRecallTarget, SourceSemanticWorkerRequestSchema, SourceSemanticWorkerResultSchema, SourceSemanticWorkerWorkSchema,
  type RequestBudget, type SourceEvidenceTarget, type SourceSemanticWorkerRequest,
  type SourceSemanticWorkerResult, type SourceSemanticWorkerWork
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { bindSourceSemanticLocations } from "../../memory/evidence-create/source-semantic-location.js";
import { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";

type ReasonRequest = Extract<SourceSemanticWorkerRequest, { kind: "reason" }>;
type ReasonResult = Extract<SourceSemanticWorkerResult, { kind: "reason" }>;
type ValidatedSource = Extract<SourceSemanticWorkerResult, { kind: "validate_source" }>;
export type SourceFeedbackSessionInput = Readonly<{
  request_id: string; parent_entitlement_id: string;
  workspace_id: string; original_query: string; scope_identity: string; as_of: string;
  source_id: string; source_target: SourceEvidenceTarget;
  /** Selected H/Q/C, not an authoritative demand. Only native acceptance can produce navigation. */
  seed: ReasonRequest;
  budget: RequestBudget; action_budget: RequestBudget;
}>;
export type SourceFeedbackAction = Readonly<{
  action_id: string; demand_id: string; parent_entitlement_id: string;
  request: SourceSemanticWorkerRequest;
}>;
export type SourceFeedbackTerminalCause = Readonly<{
  kind: "caller_abort" | "execution_error";
  reason: unknown; name?: string; message?: string; code?: string; subCode?: string;
  diagnostic?: Readonly<{ status: "unavailable" | "partial" }>;
}>;
export type SourceFeedbackSettlement =
  | Readonly<{ status: "observed"; result: SourceSemanticWorkerResult }>
  | Readonly<{ status: "failed"; work?: SourceSemanticWorkerWork; terminal_cause?: SourceFeedbackTerminalCause }>
  | Readonly<{ status: "unknown"; phase: "waiting" | "preparing" | "dispatched" | "unknown"; terminal_cause?: SourceFeedbackTerminalCause }>
  | Readonly<{ status: "cancelled"; terminal_cause?: SourceFeedbackTerminalCause }>;
type Demand = { id: string; request: SourceSemanticWorkerRequest };

/** Request-local single writer. Discovery is navigation, never a joined conditional proof.
 * No continuation, persistent graph, source writer, or arbitrary blocked binding recovery lives here. */
export function createSourceFeedbackSession(input: SourceFeedbackSessionInput) {
  const captured = structuredClone(input);
  const parsedSeed = SourceSemanticWorkerRequestSchema.parse(captured.seed);
  if (parsedSeed.kind !== "reason" || parsedSeed.query_handle !== undefined || parsedSeed.source_interpretation_id === undefined
    || parsedSeed.original_query !== captured.original_query || captured.source_target.workspace_id !== captured.workspace_id) {
    throw new CoreError("VALIDATION", "feedback requires a source-bound one-shot root computation");
  }
  const seed: ReasonRequest = parsedSeed;
  for (const budget of [captured.budget, captured.action_budget]) {
    // Use the worker request admission, including reserve/page constraints.
    SourceSemanticWorkerRequestSchema.parse({ kind: "prepare_source", source_id: captured.source_id, budget });
  }
  const root = canonicalJson([captured.workspace_id, captured.original_query, captured.scope_identity, captured.as_of]);
  const queue: Demand[] = [], seen = new Set<string>(), workKeys = new Set<string>();
  const settlements = new Map<string, SourceFeedbackSettlement>();
  const exposures: { exposure_id: string; action_id: string; result: SourceSemanticWorkerResult }[] = [];
  let active: SourceFeedbackAction | undefined, validated: ValidatedSource | undefined;
  let stopped: "complete" | "failed" | "unknown" | "cancelled" | "budget_exhausted" | "non_actionable" | undefined;
  let terminalCause: SourceFeedbackTerminalCause | undefined;
  let work = 0, bytes = 0, reservedWork = 0, reservedBytes = 0, serial = 0;

  function enqueue(material: unknown, request: SourceSemanticWorkerRequest): void {
    // Attempts, exposure identities and recursively growing parent paths are deliberately absent.
    const id = canonicalJson([root, material]);
    const workKey = canonicalJson(request);
    if (seen.has(id) || workKeys.has(workKey)) return;
    seen.add(id); workKeys.add(workKey); queue.push({ id, request });
  }
  enqueue(["source", captured.source_target], { kind: "prepare_source", source_id: captured.source_id, budget: captured.action_budget });

  function next(): { status: "action"; action: SourceFeedbackAction } | { status: "in_flight" | "stopped" } {
    if (active !== undefined) return { status: "in_flight" };
    if (stopped !== undefined) return { status: "stopped" };
    const demand = queue.shift();
    if (demand === undefined) { stopped = "complete"; return { status: "stopped" }; }
    const allocation = captured.action_budget;
    if (work + reservedWork + allocation.work_units > captured.budget.work_units
      || bytes + reservedBytes + allocation.memory_bytes > captured.budget.memory_bytes) {
      stopped = "budget_exhausted"; return { status: "stopped" };
    }
    reservedWork += allocation.work_units; reservedBytes += allocation.memory_bytes;
    active = Object.freeze({ action_id: `${captured.request_id}:${++serial}`, demand_id: demand.id,
      parent_entitlement_id: captured.parent_entitlement_id,
      request: structuredClone({ ...demand.request, budget: allocation }) });
    // A caller cannot rewrite the reserved operation or its binding-derived navigation.
    return { status: "action", action: structuredClone(active) };
  }

  function accept(actionId: string, settlement: SourceFeedbackSettlement): boolean {
    if (settlements.has(actionId)) return false;
    if (active?.action_id !== actionId || stopped !== undefined) return false;
    const action = active;
    const owned = structuredClone(settlement);
    settlements.set(actionId, owned); active = undefined;
    if (owned.status !== "observed" && owned.terminal_cause !== undefined) terminalCause = owned.terminal_cause;
    if (owned.status === "unknown" || owned.status === "cancelled") {
      stopped = owned.status; return true; // Unknown/uncancelled native work is never refunded.
    }
    const parsed = owned.status === "observed" ? SourceSemanticWorkerResultSchema.safeParse(owned.result) : undefined;
    if (parsed !== undefined && (!parsed.success || parsed.data.kind !== action.request.kind)) {
      stopped = "unknown"; return true;
    }
    const result = parsed?.success ? parsed.data : undefined;
    const usage = result?.work ?? (owned.status === "failed" ? owned.work : undefined);
    if (!SourceSemanticWorkerWorkSchema.safeParse(usage).success || usage?.logical_work === undefined
      || usage.logical_work > action.request.budget.work_units || usage.logical_memory_bytes > action.request.budget.memory_bytes) {
      stopped = "unknown"; return true; // Rejected measurement is not evidence with which to settle the reservation.
    }
    // These are already inclusive child totals. Native/index/access/inner resource_usage are NOT added.
    work += usage.logical_work; bytes += usage.logical_memory_bytes;
    reservedWork -= action.request.budget.work_units; reservedBytes -= action.request.budget.memory_bytes;
    if (owned.status === "failed") { stopped = "failed"; return true; }
    if (result === undefined) { stopped = "unknown"; return true; }
    exposures.push({ exposure_id: `${captured.request_id}:exposure:${exposures.length + 1}`, action_id: actionId, result });
    try { advance(result); }
    catch (error) { stopped = "unknown"; terminalCause = captureSourceFeedbackTerminalCause(error, "execution_error"); }
    return true;
  }

  function advance(result: SourceSemanticWorkerResult): void {
    if (result.kind === "prepare_source") {
      if (!sameSource(result)) { stopped = "non_actionable"; return; }
      enqueue(["validate", captured.source_target], { kind: "validate_source", source_handle: result.source_handle, budget: captured.action_budget });
    } else if (result.kind === "validate_source") {
      if (!sameSource(result)) { stopped = "non_actionable"; return; }
      validated = result;
      enqueue(["reason", seed.source_interpretation_id], seed);
    } else if (result.kind === "reason") {
      const demands = validated === undefined ? [] : acceptingNavigation(result, captured, validated);
      if (demands.length === 0) { stopped = "non_actionable"; return; }
      for (const demand of demands) enqueue(demand.identity, {
        kind: "prepare_query", original_query: captured.original_query, access_hint: demand.text,
        query_semantics: result.query!, budget: captured.action_budget
      });
    }
    // prepare_query yields new observations only. It neither settles chronology nor starts a frozen continuation.
  }

  function sameSource(source: Pick<ValidatedSource, "source_id" | "source_version" | "content_digest">): boolean {
    return source.source_id === captured.source_id && source.source_version === captured.source_target.source_version
      && source.content_digest === captured.source_target.content_digest;
  }

  function finish() {
    return structuredClone({ request_id: captured.request_id, parent_entitlement_id: captured.parent_entitlement_id,
      status: stopped ?? (active === undefined && queue.length === 0 ? "complete" : "pending"),
      ...(terminalCause === undefined ? {} : { terminal_cause: terminalCause }),
      accounting: { logical_work: work, logical_memory_bytes: bytes,
        reserved_work: reservedWork, reserved_memory_bytes: reservedBytes,
        measurement: "logical_not_native_cpu" as const },
      exposures, settlements: [...settlements.entries()],
      joint_assessment: { status: "not_lowered" as const, reason: "source_qualified_join_and_temporal_comparison_not_admitted" as const } });
  }
  function stop(status: "cancelled" | "unknown", cause?: SourceFeedbackTerminalCause): void {
    if (stopped !== undefined) return;
    if (active !== undefined) accept(active.action_id, status === "cancelled" ? { status, terminal_cause: cause }
      : { status, phase: "unknown", terminal_cause: cause });
    else if (cause !== undefined) terminalCause = structuredClone(cause);
    stopped ??= status;
  }
  return { next, accept, finish, stop };
}
export type SourceFeedbackSession = ReturnType<typeof createSourceFeedbackSession>;

function copyOwnEnumerableCauseExtras(target: object, source: object): void {
  for (const key of Object.keys(source)) {
    if (key === "name" || key === "message" || key === "code" || key === "subCode" || key === "stack" || key === "cause") continue;
    const desc = Object.getOwnPropertyDescriptor(source, key);
    if (desc === undefined) continue;
    // Own __proto__ must stay a data property. Assignment would change the prototype.
    const value = Object.hasOwn(desc, "value") ? desc.value : Reflect.get(source, key);
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  }
}

/** Termination cause is not evidence of how much native execution completed. */
export function captureSourceFeedbackTerminalCause(reason: unknown, kind: SourceFeedbackTerminalCause["kind"]): SourceFeedbackTerminalCause {
  // accept/stop/finish clone this value. Unsafe abort data must not replace cancellation or unknown occupancy.
  const unavailable = (): SourceFeedbackTerminalCause =>
    ({ kind, reason: { status: "unavailable" as const }, diagnostic: { status: "unavailable" } });
  try {
    const isError = reason instanceof Error;
    const code = isError && "code" in reason ? reason.code : undefined;
    const subCode = isError && "subCode" in reason ? reason.subCode : undefined;
    const fields = isError ? {
      name: reason.name, message: reason.message,
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof subCode === "string" ? { subCode } : {})
    } : {};
    let nested: unknown, hasCause = false, stack: string | undefined;
    try {
      hasCause = isError && "cause" in reason;
      if (isError && hasCause) {
        nested = { status: "unavailable" as const };
        const causeValue = reason.cause;
        if (causeValue instanceof Error) {
          const nestedCode = "code" in causeValue ? causeValue.code : undefined;
          const nestedSubCode = "subCode" in causeValue ? causeValue.subCode : undefined;
          const nestedError = {
            name: causeValue.name, message: causeValue.message, stack: causeValue.stack,
            ...(typeof nestedCode === "string" ? { code: nestedCode } : {}),
            ...(typeof nestedSubCode === "string" ? { subCode: nestedSubCode } : {})
          };
          copyOwnEnumerableCauseExtras(nestedError, causeValue);
          nested = nestedError;
        } else nested = causeValue;
      }
      if (!(reason instanceof Error)) return structuredClone({ kind, reason });
      stack = reason.stack;
      const snapshot = { ...fields, stack, ...(hasCause ? { cause: nested } : {}) };
      copyOwnEnumerableCauseExtras(snapshot, reason);
      return structuredClone({ kind, reason: snapshot, ...fields });
    } catch {
      if (!isError) return unavailable();
      let cause: unknown;
      if (hasCause) {
        try { cause = structuredClone(nested); }
        catch { cause = { status: "unavailable" as const }; }
      }
      try {
        return structuredClone({
          kind, ...fields, diagnostic: { status: "partial" as const },
          reason: { ...fields, ...(typeof stack === "string" ? { stack } : {}), ...(hasCause ? { cause } : {}) }
        });
      } catch { return unavailable(); }
    }
  } catch { return unavailable(); }
}

function acceptingNavigation(delivery: ReasonResult, input: SourceFeedbackSessionInput, source: ValidatedSource) {
  const { result, interpretation, query, semantic_correspondence: correspondence, context } = delivery;
  if (result?.outcome.status !== "interpreted" || delivery.coverage.payload !== "complete"
    || interpretation === undefined || query === undefined || correspondence === undefined || context === undefined
    || result.source_target === undefined || !sameRecallTarget(result.source_target, input.source_target)
    || interpretation.source.source_id !== source.source_id || interpretation.source.source_version !== source.source_version
    || interpretation.source.content_digest !== source.content_digest) return [];
  const admission = admitSourceSemanticCorrespondence({ source_interpretation: interpretation,
    query_semantics: query, semantic_correspondence: correspondence, original_query: input.original_query });
  if (admission.kind !== "admitted" || canonicalJson(context) !== canonicalJson(admission.context)
    || result.conditional_computation_id !== admission.context_id || result.source_interpretation_id !== admission.interpretation_id
    || admission.interpretation_id !== input.seed.source_interpretation_id || result.query_semantics_id !== admission.query_id
    || result.semantic_correspondence_id !== admission.semantic_correspondence_id
    || canonicalJson(input.seed.query_semantics) !== canonicalJson(query)
    || canonicalJson(input.seed.semantic_correspondence) !== canonicalJson(correspondence)) return [];
  try {
    bindSourceSemanticLocations({ source: source.source, interpretation, catalog: source.catalog,
      locations: source.assertion_locations, sha256: fieldContractSha256 });
  } catch (error) {
    if (error instanceof CoreError && error.code === "VALIDATION") return [];
    throw error; // A failed location owner is not successful evidence of an unusable/empty binding.
  }
  const demands: { identity: unknown; text: string }[] = [];
  for (const binding of result.binding_results ?? []) {
    if (query.alternatives[binding.alternative] === undefined || !completeDeliveredClosure(result, binding.explanation_ids)) continue;
    for (const [variable, coordinate] of Object.entries(binding.bindings)) {
      // Fixed query literals and derived nodes are not newly bound source navigation values.
      const declaration = query.variables.find(row => row.id === variable);
      if (declaration?.sort !== "entity" || declaration.reference !== undefined
        || coordinate.packet_id !== admission.interpretation_id || coordinate.hypothesis_id !== admission.context_id) continue;
      const referent = interpretation.referents.find(row => row.id === coordinate.node_id);
      if (referent === undefined) continue;
      for (const id of referent.mentions) {
        const mention = interpretation.mentions.find(row => row.id === id);
        if (mention === undefined) continue;
        const text = mention.text;
        if (text.trim().length === 0 || text.length > 1024) continue;
        demands.push({ identity: ["accepting_navigation", input.source_target, admission.context_id,
          binding.alternative, binding.kind, variable, coordinate, text], text });
      }
    }
  }
  return demands;
}

/** Validate delivered support only; do not recover an environment from its opaque binding_id. */
function completeDeliveredClosure(result: NonNullable<ReasonResult["result"]>, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;
  const rows = new Map(result.derivations?.map(row => [row.derivation_id, row]));
  const leaves = new Map(result.evidence_leaves?.map(row => [row.observation_id, row.leaf]));
  const consumed = new Set(result.consumed_leaves.map(row => canonicalJson(row)));
  const delivered = new Set([...leaves.values()].map(row => canonicalJson(row)));
  if ([...consumed].some(leaf => !delivered.has(leaf))) return false;
  const done = new Set<string>(), visiting = new Set<string>();
  const stack = roots.map(id => ({ id, exit: false }));
  let observations = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.exit) { visiting.delete(item.id); done.add(item.id); continue; }
    if (done.has(item.id)) continue;
    const row = rows.get(item.id);
    if (row === undefined || visiting.has(item.id)) return false;
    for (const id of row.observation_ids) {
      const leaf = leaves.get(id);
      // The producer only maps source/H/C origins. Seed and program-transition
      // observations still belong to the closed forest but are not semantic leaves.
      if (leaf === undefined) continue;
      if (!consumed.has(canonicalJson(leaf))) return false;
      observations += 1;
    }
    visiting.add(item.id); stack.push({ id: item.id, exit: true });
    for (const id of row.children) stack.push({ id, exit: false });
  }
  return observations > 0;
}
