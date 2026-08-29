import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import {
  CANONICAL_QUERY_LIMITS,
  CANONICAL_QUERY_OPERATOR_ID,
  CanonicalQueryContractError,
  type CanonicalAnswerProgramV1,
  type CanonicalCompletionV1,
  type CanonicalConstantV1,
  type CanonicalConstraintV1,
  type CanonicalPredicateV1,
  type CanonicalQueryUnsupportedCode,
  type CanonicalQueryV1,
  type CanonicalQueryValidationV1,
  type CanonicalVariableV1
} from "./types.js";

export type CanonicalQueryInputV1 = Readonly<{
  readonly variables: readonly CanonicalVariableV1[];
  readonly constants?: readonly CanonicalConstantV1[];
  readonly predicates?: readonly CanonicalPredicateV1[];
  readonly constraints?: readonly CanonicalConstraintV1[];
  readonly answer?: CanonicalAnswerProgramV1;
  readonly answers?: readonly CanonicalAnswerProgramV1[];
  readonly unsupported?: "count" | "sum" | "latest" | "earliest" | "nesting";
}>;

type AllObservableCompletionV1 = Extract<CanonicalCompletionV1, { kind: "all_observable" }>;

export function validateCanonicalQueryV1(
  input: CanonicalQueryInputV1
): CanonicalQueryValidationV1 {
  const explicit = explicitUnsupported(input.unsupported);
  if (explicit !== null) return explicit;
  if ((input.answers?.length ?? 0) > 1) return unsupported("multiple_terminal_programs");
  const answer = input.answer ?? input.answers?.[0];
  if (answer === undefined) return unsupported("multiple_terminal_programs");
  try {
    return { status: "supported", query: createCanonicalQueryV1({ ...input, answer }) };
  } catch (error) {
    if (error instanceof CanonicalQueryContractError) {
      return unsupported(error.code, error.message);
    }
    throw error;
  }
}

export function createCanonicalQueryV1(input: CanonicalQueryInputV1 & {
  readonly answer: CanonicalAnswerProgramV1;
}): CanonicalQueryV1 {
  const variables = freezeVariables(input.variables);
  const constants = freezeConstants(input.constants ?? []);
  const predicates = freezePredicates(input.predicates ?? []);
  const constraints = freezeConstraints(input.constraints ?? []);
  assertLimits(variables, constants, predicates, constraints, input.answer);
  const names = bindNames(variables, constants);
  bindPhi(predicates, constraints, names);
  bindAnswer(input.answer, names, { extrema: 0, depth: 0 });
  const query = Object.freeze({
    schema_version: 1 as const,
    operator_id: CANONICAL_QUERY_OPERATOR_ID,
    variables,
    constants,
    predicates,
    constraints,
    answer: freezeAnswer(input.answer)
  });
  return query;
}

export function serializeCanonicalQueryV1(query: CanonicalQueryV1): string {
  return stableStringify(normalizeCanonicalQuery(query));
}

export function digestCanonicalQueryV1(query: CanonicalQueryV1): RecallFieldDigest {
  return digestRecallFieldIdentity(normalizeCanonicalQuery(query));
}

export function bindAllObservableCompletion(input: {
  readonly principal: string;
  readonly scope: string;
  readonly observer_universe: readonly string[];
}): AllObservableCompletionV1 {
  const observer_universe = freezeObserverUniverse(input.observer_universe);
  return freezeAllObservable({
    kind: "all_observable",
    principal: input.principal,
    scope: input.scope,
    snapshot_bind: "Sigma_q",
    observer_universe,
    observer_contract: digestAllObservableObserverContract({
      principal: input.principal,
      scope: input.scope,
      observer_universe
    })
  });
}

function explicitUnsupported(
  kind: CanonicalQueryInputV1["unsupported"]
): CanonicalQueryValidationV1 | null {
  if (kind === "count" || kind === "sum") return unsupported("count_sum_unsupported");
  if (kind === "latest" || kind === "earliest") {
    return unsupported("latest_without_typed_time_key");
  }
  if (kind === "nesting") return unsupported("unsupported_nesting");
  return null;
}

const VARIABLE_SORTS = new Set<CanonicalVariableV1["sort"]>([
  "entity", "scalar", "time", "answer", "order_key"
]);

function freezeVariables(
  variables: readonly CanonicalVariableV1[]
): readonly CanonicalVariableV1[] {
  const names = new Set<string>();
  return Object.freeze(variables.map((variable) => {
    const name = requireToken(variable.name);
    if (names.has(name)) throw new CanonicalQueryContractError("undeclared_variable");
    if (!VARIABLE_SORTS.has(variable.sort)) {
      throw new CanonicalQueryContractError("invalid_sort");
    }
    names.add(name);
    return Object.freeze({ name, sort: variable.sort });
  }));
}

function freezeConstants(
  constants: readonly CanonicalConstantV1[]
): readonly CanonicalConstantV1[] {
  const names = new Set<string>();
  return Object.freeze(constants.map((constant) => {
    const name = requireToken(constant.name);
    const value = requireToken(constant.value);
    if (names.has(name)) throw new CanonicalQueryContractError("undeclared_variable");
    if (constant.sort !== "entity" && constant.sort !== "scalar" && constant.sort !== "time") {
      throw new CanonicalQueryContractError("invalid_sort");
    }
    names.add(name);
    return Object.freeze({ name, sort: constant.sort, value });
  }));
}

type NameBinding =
  | Readonly<{ readonly kind: "variable"; readonly sort: CanonicalVariableV1["sort"] }>
  | Readonly<{ readonly kind: "constant"; readonly sort: CanonicalConstantV1["sort"] }>;

function bindNames(
  variables: readonly CanonicalVariableV1[],
  constants: readonly CanonicalConstantV1[]
): ReadonlyMap<string, NameBinding> {
  const names = new Map<string, NameBinding>();
  for (const variable of variables) {
    names.set(variable.name, Object.freeze({ kind: "variable", sort: variable.sort }));
  }
  for (const constant of constants) {
    if (names.has(constant.name)) {
      throw new CanonicalQueryContractError("undeclared_variable");
    }
    names.set(constant.name, Object.freeze({ kind: "constant", sort: constant.sort }));
  }
  return names;
}

function freezePredicates(
  predicates: readonly CanonicalPredicateV1[]
): readonly CanonicalPredicateV1[] {
  const ids = uniqueAtomIds(predicates, "predicate");
  return Object.freeze(predicates.map((predicate) => {
    const frozen: CanonicalPredicateV1 = {
      id: ids.get(predicate.id) ?? predicate.id,
      relation: requireToken(predicate.relation),
      arguments: Object.freeze(predicate.arguments.map(requireToken))
    };
    if (predicate.provenance !== undefined) {
      return Object.freeze({
        ...frozen,
        provenance: freezeProvenance(predicate.provenance)
      });
    }
    return Object.freeze(frozen);
  }));
}

function freezeProvenance(
  provenance: CanonicalPredicateV1["provenance"] & object
): NonNullable<CanonicalPredicateV1["provenance"]> {
  return Object.freeze({
    source_id: requireToken(provenance.source_id),
    producer: requireToken(provenance.producer)
  });
}

function freezeConstraints(
  constraints: readonly CanonicalConstraintV1[]
): readonly CanonicalConstraintV1[] {
  const ids = uniqueAtomIds(constraints, "constraint");
  return Object.freeze(constraints.map((constraint) => Object.freeze({
    ...constraint,
    id: ids.get(constraint.id) ?? constraint.id,
    constraint: requireToken(constraint.constraint),
    arguments: Object.freeze(constraint.arguments.map(requireToken))
  })));
}

function uniqueAtomIds(
  atoms: readonly { readonly id: string }[],
  label: "predicate" | "constraint"
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const atom of atoms) {
    const id = requireToken(atom.id);
    if (ids.has(id)) throw new CanonicalQueryContractError("limit_overflow", label);
    ids.set(atom.id, id);
  }
  return ids;
}

function assertLimits(
  variables: readonly CanonicalVariableV1[],
  constants: readonly CanonicalConstantV1[],
  predicates: readonly CanonicalPredicateV1[],
  constraints: readonly CanonicalConstraintV1[],
  answer: CanonicalAnswerProgramV1
): void {
  if (variables.length > CANONICAL_QUERY_LIMITS.max_variables) {
    throw new CanonicalQueryContractError("limit_overflow", "variables");
  }
  if (constants.length > CANONICAL_QUERY_LIMITS.max_constants) {
    throw new CanonicalQueryContractError("limit_overflow", "constants");
  }
  if (predicates.length + constraints.length
    > CANONICAL_QUERY_LIMITS.max_predicates_and_constraints) {
    throw new CanonicalQueryContractError("limit_overflow", "phi");
  }
  for (const atom of [...predicates, ...constraints]) {
    if (atom.arguments.length > CANONICAL_QUERY_LIMITS.max_arguments) {
      throw new CanonicalQueryContractError("limit_overflow", "arguments");
    }
  }
  if (answerDepth(answer) > CANONICAL_QUERY_LIMITS.max_depth) {
    throw new CanonicalQueryContractError("limit_overflow", "depth");
  }
}

function bindPhi(
  predicates: readonly CanonicalPredicateV1[],
  constraints: readonly CanonicalConstraintV1[],
  names: ReadonlyMap<string, NameBinding>
): void {
  for (const atom of [...predicates, ...constraints]) {
    for (const argument of atom.arguments) requireName(argument, names);
  }
}

function bindAnswer(
  answer: CanonicalAnswerProgramV1,
  names: ReadonlyMap<string, NameBinding>,
  walk: { extrema: number; depth: number }
): void {
  const depth = walk.depth + 1;
  if (depth > CANONICAL_QUERY_LIMITS.max_depth) {
    throw new CanonicalQueryContractError("limit_overflow", "depth");
  }
  if (answer.kind === "scalar" || answer.kind === "distinct" || answer.kind === "sequence") {
    requireVariable(answer.variable, names);
  }
  if (answer.kind === "argmax" || answer.kind === "argmin" || answer.kind === "sequence") {
    const extrema = walk.extrema + 1;
    if (extrema > CANONICAL_QUERY_LIMITS.max_extrema) {
      throw new CanonicalQueryContractError("limit_overflow", "extrema");
    }
    const order = requireVariable(answer.order_key, names);
    if (order.sort !== "time" && order.sort !== "order_key") {
      throw new CanonicalQueryContractError("unbound_order_key");
    }
    if (answer.kind !== "sequence" && order.sort !== "time") {
      throw new CanonicalQueryContractError("wrong_temporal_domain");
    }
    if (answer.kind !== "sequence") bindAnswer(answer.inner, names, { extrema, depth });
  }
  if (answer.kind === "distinct" || answer.kind === "sequence") {
    freezeCompletion(answer.completion);
  }
}

function requireName(
  name: string,
  names: ReadonlyMap<string, NameBinding>
): NameBinding {
  const binding = names.get(name);
  if (binding === undefined) {
    throw new CanonicalQueryContractError("undeclared_variable");
  }
  return binding;
}

function requireVariable(
  name: string,
  names: ReadonlyMap<string, NameBinding>
): Extract<NameBinding, { kind: "variable" }> {
  const binding = requireName(name, names);
  if (binding.kind !== "variable") {
    throw new CanonicalQueryContractError("undeclared_variable");
  }
  return binding;
}

function freezeAnswer(answer: CanonicalAnswerProgramV1): CanonicalAnswerProgramV1 {
  if (answer.kind === "scalar") {
    return Object.freeze({ kind: "scalar", variable: answer.variable });
  }
  if (answer.kind === "distinct") {
    return Object.freeze({
      kind: "distinct",
      variable: answer.variable,
      completion: freezeCompletion(answer.completion)
    });
  }
  if (answer.kind === "sequence") {
    return Object.freeze({
      kind: "sequence",
      order_key: answer.order_key,
      variable: answer.variable,
      completion: freezeCompletion(answer.completion)
    });
  }
  return Object.freeze({
    kind: answer.kind,
    order_key: answer.order_key,
    inner: freezeAnswer(answer.inner)
  });
}

const FORBIDDEN_OBSERVER_UNIVERSE_TOKENS = new Set(["*", "all", "all_known", "∞"]);

function freezeCompletion(completion: CanonicalCompletionV1): CanonicalCompletionV1 {
  if (completion.kind === "at_most") {
    if (!Number.isSafeInteger(completion.n) || completion.n < 1) {
      throw new CanonicalQueryContractError("limit_overflow", "at_most");
    }
    return Object.freeze({ kind: "at_most", n: completion.n });
  }
  return freezeAllObservable(completion);
}

function freezeAllObservable(completion: AllObservableCompletionV1): AllObservableCompletionV1 {
  if (completion.snapshot_bind !== "Sigma_q") {
    throw new CanonicalQueryContractError("invalid_all_observable");
  }
  const scope = requireToken(completion.scope);
  const principal = requireToken(completion.principal);
  const observer_universe = freezeObserverUniverse(completion.observer_universe);
  const observer_contract = digestAllObservableObserverContract({
    principal,
    scope,
    observer_universe
  });
  if (completion.observer_contract !== observer_contract) {
    throw new CanonicalQueryContractError("invalid_all_observable");
  }
  return Object.freeze({
    kind: "all_observable" as const,
    scope,
    principal,
    snapshot_bind: "Sigma_q" as const,
    observer_universe,
    observer_contract
  });
}

function freezeObserverUniverse(universe: readonly string[]): readonly string[] {
  // Silent unique would bind a different observer set than the caller named.
  if (!Array.isArray(universe) || universe.length === 0) {
    throw new CanonicalQueryContractError("invalid_all_observable");
  }
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of universe) {
    if (
      token.length === 0
      || token.trim() !== token
      || FORBIDDEN_OBSERVER_UNIVERSE_TOKENS.has(token)
      || seen.has(token)
    ) {
      throw new CanonicalQueryContractError("invalid_all_observable");
    }
    seen.add(token);
    tokens.push(token);
  }
  return Object.freeze(tokens.sort((left, right) => left.localeCompare(right)));
}

function digestAllObservableObserverContract(input: {
  readonly principal: string;
  readonly scope: string;
  readonly observer_universe: readonly string[];
}): RecallFieldDigest {
  return digestRecallFieldIdentity({
    kind: "all_observable_observer_contract_v1",
    principal: input.principal,
    scope: input.scope,
    snapshot_bind: "Sigma_q",
    observer_universe: input.observer_universe
  });
}

function answerDepth(answer: CanonicalAnswerProgramV1): number {
  if (answer.kind === "argmax" || answer.kind === "argmin") {
    return 1 + answerDepth(answer.inner);
  }
  return 1;
}

function normalizeCanonicalQuery(query: CanonicalQueryV1): CanonicalQueryV1 {
  return Object.freeze({
    ...query,
    variables: Object.freeze(
      [...query.variables].sort((left, right) => left.name.localeCompare(right.name))
    ),
    constants: Object.freeze(
      [...query.constants].sort((left, right) => left.name.localeCompare(right.name))
    ),
    predicates: Object.freeze(
      [...query.predicates].sort((left, right) => left.id.localeCompare(right.id))
    ),
    constraints: Object.freeze(
      [...query.constraints].sort((left, right) => left.id.localeCompare(right.id))
    )
  });
}

function unsupported(
  reason_code: CanonicalQueryUnsupportedCode,
  message?: string
): CanonicalQueryValidationV1 {
  return Object.freeze({ status: "unsupported", reason_code, message: message ?? reason_code });
}

function requireToken(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new CanonicalQueryContractError("undeclared_variable");
  }
  return value;
}
