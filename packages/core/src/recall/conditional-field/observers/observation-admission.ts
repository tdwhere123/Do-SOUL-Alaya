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
import {
  classifyQueryPredicate,
  evaluateFrozenSourcePredicate,
  type SourcePredicateSubject
} from "../query/source-predicates.js";
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
    args.sourceRoot,
    args.relation
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

type ObserverRole =
  | { readonly kind: "seed" }
  | { readonly kind: "assertion"; readonly predicate: string }
  | { readonly kind: "embedding" };

function applicabilityFor(
  input: ObserveConditionalFieldInput,
  objectId: string,
  observedAt: string | undefined,
  sourceRow: SourceObserverRow | undefined,
  identityKind: "object" | "assertion" | "embedding",
  sourceRoot?: SourceRootObserverRow,
  relation?: RelationObserverRow
): Guard {
  const extras = [
    ...(input.query.source_guard === undefined ? [] : [input.query.source_guard]),
    ...(input.query.interpretation_proposal?.conditions ?? [])
  ];
  const authorization = evaluateAuthorization(
    input,
    [...collectGuards(input.query.program), ...extras],
    sourceRow,
    sourceRoot
  );
  if (authorization.verdict === "false") return authorization;
  if (sourceRow === undefined && sourceRoot === undefined && identityKind !== "embedding") {
    return { schema_version: SCHEMA, kind: "query_predicate", verdict: "unresolved" };
  }
  const role = observerRole(identityKind, relation);
  const combined = andObserverDecisions([
    decideProgramObserver(input.query.program, input, objectId, observedAt, sourceRow, sourceRoot, role),
    decideExtraGuards(extras, input, objectId, observedAt, sourceRow, sourceRoot, role)
  ]);
  if (combined !== undefined && combined.verdict !== "true") return combined;
  return authorization.kind === "authorization"
    ? { ...authorization, verdict: "true" }
    : { schema_version: SCHEMA, kind: "query_predicate", verdict: "true" };
}

function observerRole(
  identityKind: "object" | "assertion" | "embedding",
  relation?: RelationObserverRow
): ObserverRole {
  if (identityKind === "embedding") return { kind: "embedding" };
  if (identityKind === "assertion" && relation !== undefined) {
    return { kind: "assertion", predicate: relation.predicate };
  }
  return { kind: "seed" };
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
  sourceRow: SourceObserverRow | undefined,
  sourceRoot: SourceRootObserverRow | undefined,
  subject: string | ReadonlySet<string>
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
  if (!guardBindsSubject(guard, subject)) return undefined;
  if (guard.kind === "query_predicate") {
    const classified = classifyQueryPredicate(guard.predicate_name);
    if (classified.kind === "frozen") {
      return {
        ...guard,
        verdict: evaluateFrozenSourcePredicate(
          classified.name,
          guard,
          predicateSubject(sourceRoot, sourceRow)
        )
      };
    }
    if (classified.kind === "unknown") return { ...guard, verdict: "unresolved" };
    const filters = decodeSourceFilters(guard.predicate_name);
    if (filters === undefined) return undefined;
    if (filters.event_kind !== undefined && input.action.action !== "seed") return undefined;
    const verdict = sourceRoot === undefined
      ? sourceFactsSatisfyFilters(filters, sourceRow)
      : sourceRootFilters(filters, sourceRoot);
    return { ...guard, verdict };
  }
  return { ...guard, verdict: "unresolved" };
}

function guardBindsSubject(guard: Guard, subject: string | ReadonlySet<string>): boolean {
  if (guard.variable === undefined) return true;
  return typeof subject === "string" ? guard.variable === subject : subject.has(guard.variable);
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

function decideProgramObserver(
  program: QueryProgram,
  input: ObserveConditionalFieldInput,
  objectId: string,
  observedAt: string | undefined,
  sourceRow: SourceObserverRow | undefined,
  sourceRoot: SourceRootObserverRow | undefined,
  role: ObserverRole
): Guard | undefined {
  const next = (node: QueryProgram): Guard | undefined =>
    decideProgramObserver(node, input, objectId, observedAt, sourceRow, sourceRoot, role);
  switch (program.kind) {
    case "relation": {
      if (role.kind === "embedding") return undefined;
      if (role.kind === "assertion" && program.relation_kind !== role.predicate) return undefined;
      const decision = evaluateApplicableGuard(
        input,
        program.guard,
        objectId,
        observedAt,
        sourceRow,
        sourceRoot,
        role.kind === "assertion" ? program.target_variable : program.source_variable
      );
      // A relation that does not constrain this subject remains a seed option.
      return decision ?? { schema_version: SCHEMA, kind: "query_predicate", verdict: "true" };
    }
    case "sequence": {
      if (role.kind === "seed") {
        const first = program.steps[0];
        return first === undefined ? undefined : next(first);
      }
      return andObserverDecisions(program.steps.map(next));
    }
    case "alternative":
      return orObserverDecisions(program.options.map(next));
    case "repeat":
    case "closure":
      return next(program.body);
    case "hyperedge": {
      const premises = program.premises.map(next);
      return program.join === "or" ? orObserverDecisions(premises) : andObserverDecisions(premises);
    }
    default:
      return undefined;
  }
}

function decideExtraGuards(
  extras: readonly Guard[],
  input: ObserveConditionalFieldInput,
  objectId: string,
  observedAt: string | undefined,
  sourceRow: SourceObserverRow | undefined,
  sourceRoot: SourceRootObserverRow | undefined,
  role: ObserverRole
): Guard | undefined {
  const subjects = new Set<string>();
  collectObserverSubjects(input.query.program, role, subjects);
  let unresolved: Guard | undefined;
  for (const guard of extras) {
    const decision = evaluateApplicableGuard(
      input, guard, objectId, observedAt, sourceRow, sourceRoot, subjects
    );
    if (decision === undefined) continue;
    if (decision.verdict === "false") return decision;
    if (decision.verdict === "unresolved") unresolved = decision;
  }
  return unresolved;
}

function collectObserverSubjects(program: QueryProgram, role: ObserverRole, into: Set<string>): void {
  switch (program.kind) {
    case "relation":
      if (role.kind === "embedding") return;
      if (role.kind === "assertion" && program.relation_kind !== role.predicate) return;
      into.add(role.kind === "assertion" ? program.target_variable : program.source_variable);
      return;
    case "sequence": {
      if (role.kind === "seed") {
        const first = program.steps[0];
        if (first !== undefined) collectObserverSubjects(first, role, into);
        return;
      }
      for (const step of program.steps) collectObserverSubjects(step, role, into);
      return;
    }
    case "alternative":
      for (const option of program.options) collectObserverSubjects(option, role, into);
      return;
    case "repeat":
    case "closure":
      collectObserverSubjects(program.body, role, into);
      return;
    case "hyperedge":
      for (const premise of program.premises) collectObserverSubjects(premise, role, into);
      return;
    default:
      return;
  }
}

function andObserverDecisions(decisions: readonly (Guard | undefined)[]): Guard | undefined {
  let unresolved: Guard | undefined;
  for (const decision of decisions) {
    if (decision === undefined) continue;
    if (decision.verdict === "false") return decision;
    if (decision.verdict === "unresolved") unresolved = decision;
  }
  return unresolved;
}

function orObserverDecisions(decisions: readonly (Guard | undefined)[]): Guard | undefined {
  let unresolved: Guard | undefined;
  let rejection: Guard | undefined;
  for (const decision of decisions) {
    if (decision === undefined) continue;
    if (decision.verdict === "true") return decision;
    if (decision.verdict === "unresolved") unresolved = decision;
    else rejection = decision;
  }
  return unresolved ?? rejection;
}

function predicateSubject(
  sourceRoot: SourceRootObserverRow | undefined,
  sourceRow: SourceObserverRow | undefined
): SourcePredicateSubject | undefined {
  if (sourceRoot !== undefined) {
    return {
      workspace_id: sourceRoot.workspace_id,
      root_kind: sourceRoot.kind,
      root_id: sourceRoot.root_id,
      source_version: sourceRoot.revision,
      evidence_object_id: sourceRoot.evidence_object_id,
      ...(sourceRoot.evidence_verified === true ? { evidence_verified: true } : {}),
      ...(sourceRoot.content === undefined ? {} : { content: sourceRoot.content }),
      ...(sourceRoot.content_complete === undefined ? {} : { content_complete: sourceRoot.content_complete }),
      ...(sourceRoot.literal_verdicts === undefined ? {} : { literal_verdicts: sourceRoot.literal_verdicts }),
      ...(sourceRoot.role === undefined ? {} : { role: sourceRoot.role }),
      ...(sourceRoot.event_time === undefined ? {} : { event_time: sourceRoot.event_time })
    };
  }
  if (sourceRow === undefined) return undefined;
  return {
    ...(sourceRow.content === undefined ? {} : { content: sourceRow.content })
  };
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
