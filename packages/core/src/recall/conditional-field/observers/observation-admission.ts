import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  isRelationValidityActiveAt,
  type Guard,
  type QueryProgram,
  type RecallTargetRef,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  decodeSourceFilters,
  sourceFactsSatisfyFilters
} from "../query/ordinary-language.js";
import type {
  ObserveConditionalFieldInput,
  RelationObserverRow,
  SourceObserverRow,
  SourceRootObserverRow
} from "./observe.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;

export function sourceRowEligible(
  input: ObserveConditionalFieldInput,
  row: SourceObserverRow | undefined
): boolean {
  if (row === undefined) return true;
  if (row.lifecycle_state !== undefined && row.lifecycle_state !== "active") return false;
  if (row.retention_state === "tombstoned") return false;
  const asOf = input.as_of ?? input.query.interpretation_clock;
  if (asOf !== undefined && ((row.valid_from != null && row.valid_from > asOf)
    || (row.valid_to != null && row.valid_to <= asOf))) return false;
  const scopes = input.authorized_scopes ?? [];
  if (scopes.length > 0 && (row.scope_class === undefined || !scopes.includes(row.scope_class))) {
    return false;
  }
  return true;
}

export function sourceRootEligible(
  input: ObserveConditionalFieldInput,
  row: SourceRootObserverRow
): boolean {
  if (row.body_erased === true) return false;
  const asOf = input.as_of ?? input.query.interpretation_clock;
  if (asOf !== undefined && ((row.valid_from != null && row.valid_from > asOf)
    || (row.valid_to != null && row.valid_to <= asOf))) return false;
  const scopes = input.authorized_scopes ?? [];
  if (scopes.length > 0) {
    if (row.scope_class === undefined || !scopes.includes(row.scope_class)) return false;
  }
  return true;
}

export function relationRowEligible(
  input: ObserveConditionalFieldInput,
  row: RelationObserverRow
): boolean {
  const asOf = input.as_of ?? input.query.interpretation_clock;
  if (row.resolutionKind != null && (row.resolvedAt == null || asOf === undefined || row.resolvedAt <= asOf)) {
    return false;
  }
  if (row.validity === undefined) return false;
  if (asOf === undefined) return true;
  return isRelationValidityActiveAt(row.validity, asOf,
    new Set(input.permitted_timeless_policy_ids ?? input.readers.permittedTimelessPolicyIds?.() ?? []));
}

export function buildTypedObservation(
  input: ObserveConditionalFieldInput,
  args: Readonly<{
    readonly objectId: string;
    readonly sourceRevision: string;
    readonly observationKey: string;
    readonly observedAt?: string;
    readonly sourceRow?: SourceObserverRow;
    readonly sourceRoot?: SourceRootObserverRow;
    readonly target?: RecallTargetRef;
    readonly relation?: RelationObserverRow;
    readonly identityKind: "object" | "assertion" | "embedding";
  }>
): TypedObservation | null {
  if (args.sourceRoot !== undefined && !sourceRootEligible(input, args.sourceRoot)) return null;
  if (!sourceRowEligible(input, args.sourceRow)) return null;
  const applicability = applicabilityFor(
    input,
    args.objectId,
    args.observedAt,
    args.sourceRow,
    args.identityKind,
    args.sourceRoot
  );
  if (applicability.verdict === "false") return null;
  const relationKind = args.relation?.predicate ?? (
    args.identityKind === "assertion" ? input.relation_kind : undefined
  );
  const binding = packedBinding(input, args);
  const measurementId = args.identityKind === "embedding"
    ? (input.measurement_id ?? args.objectId)
    : input.measurement_id;
  const modelId = input.model_id;
  const stamp = args.sourceRoot === undefined
    ? effectObservedAt(args.observedAt, args.sourceRow)
    : args.sourceRoot.event_time ?? args.observedAt;
  return {
    schema_version: SCHEMA,
    observation_id: `${input.action.region_id}:${args.observationKey}`,
    object_id: args.objectId,
    source_revision: args.sourceRevision,
    workspace_id: input.workspace_id,
    applicability,
    ...(relationKind === undefined ? {} : { relation_kind: relationKind }),
    ...(measurementId === undefined ? {} : { measurement_id: measurementId }),
    ...(modelId === undefined ? {} : { model_id: modelId }),
    ...(binding === undefined ? {} : { binding_context: binding }),
    ...(stamp === undefined ? {} : { observed_at: stamp }),
    ...(args.target === undefined ? {} : { target: args.target })
  };
}

function effectObservedAt(
  observedAt: string | undefined,
  sourceRow: SourceObserverRow | undefined
): string | undefined {
  return observedAt ?? sourceRow?.observed_at;
}

function applicabilityFor(
  input: ObserveConditionalFieldInput,
  objectId: string,
  observedAt: string | undefined,
  sourceRow: SourceObserverRow | undefined,
  identityKind: "object" | "assertion" | "embedding",
  sourceRoot?: SourceRootObserverRow
): Guard {
  const guards = [...collectGuards(input.query.program),
    ...(input.query.source_guard === undefined ? [] : [input.query.source_guard])];
  const authorization = evaluateAuthorization(input, guards, sourceRow, sourceRoot);
  if (authorization.verdict === "false") return authorization;
  if (sourceRow === undefined && sourceRoot === undefined && identityKind !== "embedding") {
    return { schema_version: SCHEMA, kind: "query_predicate", verdict: "unresolved" };
  }
  let unresolved: Guard | undefined;
  for (const guard of guards) {
    const decision = evaluateApplicableGuard(
      input,
      guard,
      objectId,
      observedAt,
      sourceRow,
      sourceRoot
    );
    if (decision === undefined) continue;
    if (decision.verdict === "false") return decision;
    if (decision.verdict === "unresolved") unresolved = decision;
  }
  if (unresolved !== undefined) return unresolved;
  return authorization.kind === "authorization"
    ? { ...authorization, verdict: "true" }
    : { schema_version: SCHEMA, kind: "query_predicate", verdict: "true" };
}

function evaluateAuthorization(
  input: ObserveConditionalFieldInput,
  guards: readonly Guard[],
  sourceRow?: SourceObserverRow,
  sourceRoot?: SourceRootObserverRow
): Guard {
  const authorization = guards.find((guard) => guard.kind === "authorization");
  const scopes = input.authorized_scopes ?? [];
  if (authorization !== undefined) {
    const scope = authorization.authorization_scope;
    const allowed = scope === undefined || scopes.includes(scope);
    return { ...authorization, verdict: allowed ? "true" : "false" };
  }
  if (scopes.length > 0) {
    const scopeClass = sourceRoot?.scope_class ?? sourceRow?.scope_class;
    if (scopeClass === undefined || !scopes.includes(scopeClass)) {
      return { schema_version: SCHEMA, kind: "authorization", verdict: "false" };
    }
  }
  return { schema_version: SCHEMA, kind: "query_predicate", verdict: "true" };
}

function evaluateApplicableGuard(
  input: ObserveConditionalFieldInput,
  guard: Guard,
  objectId: string,
  observedAt: string | undefined,
  sourceRow?: SourceObserverRow,
  sourceRoot?: SourceRootObserverRow
): Guard | undefined {
  if (guard.kind === "authorization") return undefined;
  if (guard.kind === "interval_relation") {
    if (!appliesTimeGuard(input, guard, objectId)) return undefined;
    const filters = decodeSourceFilters(guard.predicate_name);
    if (filters !== undefined && (filters.event_kind === undefined || input.action.action === "seed")) {
      const verdict = sourceRoot === undefined
        ? sourceFactsSatisfyFilters(filters, sourceRow)
        : sourceRootFilters(filters, sourceRoot);
      if (verdict !== "true") return { ...guard, verdict };
    }
    const stamp = sourceRoot === undefined
      ? (input.object_observed_at?.[objectId] ?? observedAt ?? sourceRow?.observed_at)
      : (sourceRoot.event_time ?? undefined);
    if (sourceRoot !== undefined && stamp === undefined) {
      return { ...guard, verdict: "unresolved" };
    }
    return evaluateInterval(guard, stamp);
  }
  if (guard.kind === "query_predicate") {
    if (guard.predicate_name === "source.role.v1") {
      if (sourceRoot === undefined || sourceRoot.role === undefined) {
        return { ...guard, verdict: "unresolved" };
      }
      return { ...guard, verdict: "true" };
    }
    if (guard.predicate_name === "source.event_time.interval.v1") {
      if (sourceRoot?.event_time === undefined || sourceRoot.event_time === null) {
        return { ...guard, verdict: "unresolved" };
      }
      return { ...guard, verdict: "true" };
    }
    const filters = decodeSourceFilters(guard.predicate_name);
    if (filters === undefined) return undefined;
    if (filters.event_kind !== undefined && input.action.action !== "seed") return undefined;
    const verdict = sourceRoot === undefined
      ? sourceFactsSatisfyFilters(filters, sourceRow)
      : sourceRootFilters(filters, sourceRoot);
    return { ...guard, verdict };
  }
  return undefined;
}

function sourceRootFilters(
  filters: NonNullable<ReturnType<typeof decodeSourceFilters>>,
  root: SourceRootObserverRow
): "true" | "false" | "unresolved" {
  if (filters.dimension_filter !== undefined || filters.domain_tag_filter !== undefined) {
    return "unresolved";
  }
  if (filters.time_field === "created_at" || filters.time_field === "last_used_at") {
    return "unresolved";
  }
  if (filters.event_kind === "failed_deployment") {
    if (root.content === undefined) return "unresolved";
    const normalized = root.content.normalize("NFC").toLowerCase();
    if (!/failed|unsuccessful|deployment|deploy/u.test(normalized)) return "false";
  }
  if (filters.since !== undefined || filters.until !== undefined) {
    const stamp = root.event_time;
    if (stamp === undefined || stamp === null) return "unresolved";
    if (filters.since !== undefined && stamp < filters.since) return "false";
    if (filters.until !== undefined && stamp >= filters.until) return "false";
  }
  return "true";
}

function appliesTimeGuard(
  input: ObserveConditionalFieldInput,
  guard: Guard,
  objectId: string
): boolean {
  if (guard.time_scope === "none") return false;
  if (guard.time_scope === "anchor") {
    if (input.action.action !== "seed") return false;
    const anchors = input.anchor_object_ids;
    if (anchors === undefined || anchors.length === 0) return true;
    return anchors.includes(objectId);
  }
  if (guard.time_scope === "associated") {
    return input.action.action === "adjacency" || input.action.action === "relation";
  }
  return false;
}

function evaluateInterval(guard: Guard, observedAt: string | undefined): Guard {
  const interval = guard.interval;
  if (observedAt === undefined || interval === undefined) {
    return { ...guard, verdict: "unresolved" };
  }
  const inside = observedAt >= interval.start && observedAt < interval.end;
  return { ...guard, verdict: inside ? "true" : "false" };
}

function collectGuards(program: QueryProgram): readonly Guard[] {
  switch (program.kind) {
    case "relation":
      return [program.guard];
    case "sequence":
      return program.steps.flatMap(collectGuards);
    case "alternative":
      return program.options.flatMap(collectGuards);
    case "repeat":
    case "closure":
      return collectGuards(program.body);
    case "hyperedge":
      return program.premises.flatMap(collectGuards);
    default:
      return [];
  }
}

function packedBinding(
  input: ObserveConditionalFieldInput,
  args: Readonly<{
    readonly objectId: string;
    readonly relation?: RelationObserverRow;
    readonly identityKind: "object" | "assertion" | "embedding";
  }>
): string | undefined {
  const relation = firstRelation(input.query.program);
  const pairs: Array<readonly [string, string]> = [];
  if (args.identityKind === "assertion" && args.relation !== undefined && relation !== undefined) {
    pairs.push([relation.source, args.relation.sourceObjectId], [relation.target, args.relation.targetObjectId]);
  } else if (args.identityKind === "object" && relation !== undefined) {
    pairs.push([relation.source, args.objectId]);
  }
  if (pairs.length === 0) return undefined;
  const packed = pairs
    .filter(([variable, value]) => variable.length > 0 && value.length > 0)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([variable, value]) => `${variable}=${value}`)
    .join(";");
  if (packed.length === 0 || packed.length > 256) return undefined;
  return packed;
}

function firstRelation(program: QueryProgram): Readonly<{
  readonly source: string;
  readonly target: string;
  readonly kind: string;
}> | undefined {
  switch (program.kind) {
    case "relation":
      return { source: program.source_variable, target: program.target_variable, kind: program.relation_kind };
    case "sequence":
      for (const step of program.steps) {
        const found = firstRelation(step);
        if (found !== undefined) return found;
      }
      return undefined;
    case "alternative":
      for (const option of program.options) {
        const found = firstRelation(option);
        if (found !== undefined) return found;
      }
      return undefined;
    case "repeat":
    case "closure":
      return firstRelation(program.body);
    case "hyperedge":
      for (const premise of program.premises) {
        const found = firstRelation(premise);
        if (found !== undefined) return found;
      }
      return undefined;
    default:
      return undefined;
  }
}
