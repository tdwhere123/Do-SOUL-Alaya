import { createHash } from "node:crypto";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { ProgramAutomaton } from "./program-automaton.js";
import {
  formatConditionalFieldDigest,
  compareUtcInstants,
  sourceEvidenceRootKey,
  type RecallTargetRef,
  type Guard,
  type QueryHypothesis
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import {
  decodeSourceFilters,
  sourceFactsSatisfyFilters
} from "../query/ordinary-language.js";
import {
  classifyQueryPredicate,
  evaluateFrozenSourcePredicate
} from "../query/source-predicates.js";

export const UNBOUND_BINDING = "unbound";

export class BindingContextUnavailableError extends Error {}
export class BindingContextResourceError extends Error {}

export class BindingContextStore {
  private rows = new PersistentStringMap<string>();
  private baseRows = this.rows;
  private retainedBytes = 0;
  private sealed = false;
  public get bytes(): number { return this.retainedBytes; }
  public constructor(private limit: number) {}
  public fork(availableBytes = Math.max(0, this.limit - this.bytes)): BindingContextStore {
    const next = new BindingContextStore(this.bytes + availableBytes);
    next.rows = this.rows;
    next.baseRows = this.rows;
    next.retainedBytes = this.bytes;
    return next;
  }
  public setAvailableBytes(bytes: number): void { this.limit = this.bytes + Math.max(0, bytes); }
  public snapshot(): BindingContextStore { const next = this.fork(); next.sealed = true; return next; }
  public extends(owner: BindingContextStore): boolean { return this.rows === owner.rows || this.baseRows === owner.rows; }
  public get(digest: string): string | undefined { return this.rows.get(digest); }
  public retain(digest: string, packed: string): void {
    if (this.sealed) throw new BindingContextResourceError("fork the retained field binding owner before extending it");
    const prior = this.rows.get(digest);
    if (prior !== undefined) {
      if (prior !== packed) throw new BindingContextUnavailableError("binding digest collision");
      return;
    }
    const bytes = 128 + 2 * (digest.length + packed.length);
    if (this.bytes + bytes > this.limit) throw new BindingContextResourceError("binding context memory exhausted");
    this.rows = this.rows.with(digest, packed);
    this.retainedBytes += bytes;
  }
}

export function seedBindingContext(
  automaton: ProgramAutomaton | undefined, objectId: string,
  hypothesisBindings: QueryHypothesis["bindings"] | undefined, programState: string,
  bindingContexts?: BindingContextStore
): string | undefined {
  let env = new Map<string, string>();
  for (const binding of hypothesisBindings ?? []) env.set(binding.variable, binding.value);
  for (const variable of automaton?.sourceVariables.get(programState) ?? []) {
    const next = unifyBinding(env, variable, objectId);
    if (next === undefined) return undefined;
    env = next;
  }
  return encodeBindingContext(env, bindingContexts);
}

export function alignOutgoingBinding(
  binding: string, objectId: string, automaton: ProgramAutomaton, programState: string,
  bindingContexts?: BindingContextStore
): string | undefined {
  let env = new Map(parseBindingContext(binding, bindingContexts));
  for (const variable of automaton.localVariables.get(programState) ?? []) env.delete(variable);
  for (const advance of automaton.advances) {
    if (advance.from !== programState) continue;
    const next = unifyBinding(env, advance.relation.source_variable, objectId);
    if (next === undefined) return undefined;
    env = next;
  }
  return encodeBindingContext(env, bindingContexts);
}

export type BoundSourceFacts = Readonly<{
  readonly object_id: string;
  readonly workspace_id?: string;
  readonly root_kind?: string;
  readonly source_revision?: string;
  readonly content?: string;
  readonly content_complete?: boolean;
  readonly literal_verdicts?: Readonly<Record<string, "true" | "false" | "unresolved">>;
  readonly role?: string;
  readonly event_time?: string | null;
  readonly evidence_object_id?: string | null;
  readonly evidence_verified?: boolean;
  readonly observed_at?: string;
  readonly created_at?: string;
  readonly last_used_at?: string | null;
  readonly dimension?: string;
  readonly domain_tags?: readonly string[];
  readonly scope_class?: string;
  readonly evidence_refs?: readonly string[];
  readonly staged_warnings?: import("@do-soul/alaya-protocol").StagedWarningArray;
  readonly predicates?: Readonly<Record<string, boolean>>;
}>;

export type GuardDecision = "true" | "false" | "unresolved";

export function sourceFactKey(target: RecallTargetRef): string {
  return target.kind === "source_evidence" ? sourceEvidenceRootKey(target) : target.object_id;
}

export function parseBindingContext(context: string, owner?: BindingContextStore): Map<string, string> {
  const env = new Map<string, string>();
  const packed = recoverBindingContext(context, owner);
  if (packed.length === 0 || packed === UNBOUND_BINDING || packed === "default") {
    return env;
  }
  for (const part of packed.split(";")) {
    const sep = part.indexOf("=");
    if (sep <= 0) continue;
    env.set(unescapeBindingPart(part.slice(0, sep)), unescapeBindingPart(part.slice(sep + 1)));
  }
  return env;
}

export function encodeBindingContext(env: ReadonlyMap<string, string>, owner?: BindingContextStore): string {
  if (env.size === 0) return UNBOUND_BINDING;
  const packed = [...env.entries()]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([variable, value]) => `${escapeBindingPart(variable)}=${escapeBindingPart(value)}`)
    .join(";");
  if (packed.length <= 256) return packed;
  const digest = formatConditionalFieldDigest(
    createHash("sha256").update(JSON.stringify(packed), "utf8").digest("hex")
  );
  if (owner === undefined) throw new BindingContextUnavailableError("long binding requires an execution owner");
  owner.retain(digest, packed);
  return digest;
}

export function recoverBindingContext(context: string, owner?: BindingContextStore): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(context)) return context;
  const packed = owner?.get(context);
  if (packed === undefined) throw new BindingContextUnavailableError("binding context is unavailable in this execution");
  return packed;
}

function escapeBindingPart(value: string): string {
  // Escape only delimiters and the escape marker, preserving arbitrary UTF-16 values.
  return value.replace(/[%=;]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function unescapeBindingPart(value: string): string {
  return value.replace(/%(?:25|3D|3B)/gu, (sequence) => String.fromCharCode(Number.parseInt(sequence.slice(1), 16)));
}

export function unifyBinding(
  env: ReadonlyMap<string, string>,
  variable: string,
  value: string
): Map<string, string> | undefined {
  const existing = env.get(variable);
  if (existing === undefined) {
    const next = new Map(env);
    next.set(variable, value);
    return next;
  }
  return existing === value ? new Map(env) : undefined;
}

export function bindingsFromHypothesis(hypothesis: QueryHypothesis | undefined): Map<string, string> {
  const env = new Map<string, string>();
  if (hypothesis === undefined) return env;
  for (const binding of hypothesis.bindings) env.set(binding.variable, binding.value);
  return env;
}

export function evaluateGuard(
  guard: Guard,
  env: ReadonlyMap<string, string>,
  facts: ReadonlyMap<string, BoundSourceFacts>,
  endpoints?: Readonly<{
    readonly sourceId: string;
    readonly targetId: string;
  }>
): GuardDecision {
  // Inbound verdict is an observer/output stamp, not a Core fact.
  const filters = decodeSourceFilters(guard.predicate_name);
  if (filters !== undefined) {
    const objectId = objectForFilters(guard, env, endpoints);
    const decision = sourceFactsSatisfyFilters(filters, objectId === undefined ? undefined : facts.get(objectId));
    if (decision !== "true") return decision;
  }
  switch (guard.kind) {
    case "equality":
      return evaluateEquality(guard, env);
    case "source_bound_entity":
      return evaluateBoundEntity(guard, env);
    case "interval_relation":
      return evaluateIntervalGuard(guard, env, facts);
    case "authorization":
      return evaluateAuthorization(guard, env, facts, endpoints);
    case "query_predicate":
      return evaluateQueryPredicate(guard, env, facts, endpoints);
  }
}

export function decideGuards(
  guards: readonly Guard[],
  env: ReadonlyMap<string, string>,
  facts: ReadonlyMap<string, BoundSourceFacts>,
  endpoints?: Readonly<{ readonly sourceId: string; readonly targetId: string }>
): GuardDecision {
  let unresolved = false;
  for (const guard of guards) {
    const decision = evaluateGuard(guard, env, facts, endpoints);
    if (decision === "false") return "false";
    if (decision === "unresolved") unresolved = true;
  }
  return unresolved ? "unresolved" : "true";
}

function evaluateEquality(guard: Guard, env: ReadonlyMap<string, string>): GuardDecision {
  const left = guard.variable === undefined ? undefined : env.get(guard.variable);
  const right = guard.equals_variable === undefined ? undefined : env.get(guard.equals_variable);
  if (left === undefined || right === undefined) return "unresolved";
  return left === right ? "true" : "false";
}

function evaluateBoundEntity(guard: Guard, env: ReadonlyMap<string, string>): GuardDecision {
  const bound = guard.variable === undefined ? undefined : env.get(guard.variable);
  if (bound === undefined) return "unresolved";
  if (guard.entity_id === undefined) return "true";
  return bound === guard.entity_id ? "true" : "false";
}

function evaluateAuthorization(
  guard: Guard,
  env: ReadonlyMap<string, string>,
  facts: ReadonlyMap<string, BoundSourceFacts>,
  endpoints?: Readonly<{
    readonly sourceId: string;
    readonly targetId: string;
  }>
): GuardDecision {
  const objectId = objectForFilters(guard, env, endpoints);
  if (objectId === undefined) return "unresolved";
  const scopeClass = facts.get(objectId)?.scope_class;
  if (scopeClass === undefined) return "unresolved";
  const required = guard.authorization_scope;
  if (required === undefined) return "unresolved";
  return scopeClass === required ? "true" : "false";
}

function evaluateIntervalGuard(
  guard: Guard,
  env: ReadonlyMap<string, string>,
  facts: ReadonlyMap<string, BoundSourceFacts>
): GuardDecision {
  if (guard.time_scope === "none") return "true";
  const interval = guard.interval;
  const variable = guard.variable;
  if (variable === undefined || interval === undefined) return "unresolved";
  const objectId = env.get(variable);
  if (objectId === undefined) return "unresolved";
  const at = facts.get(objectId)?.observed_at;
  if (at === undefined) return "unresolved";
  const startOrder = compareUtcInstants(at, interval.start);
  const endOrder = compareUtcInstants(at, interval.end);
  if (startOrder === undefined || endOrder === undefined) return "unresolved";
  return startOrder >= 0 && endOrder < 0 ? "true" : "false";
}

function evaluateQueryPredicate(
  guard: Guard,
  env: ReadonlyMap<string, string>,
  facts: ReadonlyMap<string, BoundSourceFacts>,
  endpoints?: Readonly<{ readonly sourceId: string; readonly targetId: string }>
): GuardDecision {
  const classified = classifyQueryPredicate(guard.predicate_name);
  if (classified.kind === "frozen") {
    const id = objectForFilters(guard, env, endpoints);
    const bound = id === undefined ? undefined : facts.get(id);
    return evaluateFrozenSourcePredicate(classified.name, guard, bound === undefined ? undefined : {
      root_id: bound.object_id,
      workspace_id: bound.workspace_id,
      root_kind: bound.root_kind,
      source_version: bound.source_revision,
      content: bound.content,
      role: bound.role,
      event_time: bound.event_time,
      evidence_object_id: bound.evidence_object_id,
      evidence_verified: bound.evidence_verified,
      created_at: bound.created_at,
      last_used_at: bound.last_used_at
    });
  }
  if (classified.kind === "unknown") return "unresolved";
  const filters = decodeSourceFilters(guard.predicate_name);
  if (filters === undefined) {
    if (guard.predicate_name === undefined) return "true";
    const id = objectForFilters(guard, env, endpoints);
    const observed = id === undefined ? undefined : facts.get(id)?.predicates?.[guard.predicate_name];
    return observed === undefined ? "unresolved" : observed ? "true" : "false";
  }
  const objectId = objectForFilters(guard, env, endpoints);
  if (objectId === undefined) return "unresolved";
  return sourceFactsSatisfyFilters(filters, facts.get(objectId));
}

function objectForFilters(
  guard: Guard,
  env: ReadonlyMap<string, string>,
  endpoints?: Readonly<{ readonly sourceId: string; readonly targetId: string }>
): string | undefined {
  if (guard.variable !== undefined) {
    return env.get(guard.variable);
  }
  return endpoints?.targetId ?? endpoints?.sourceId;
}
