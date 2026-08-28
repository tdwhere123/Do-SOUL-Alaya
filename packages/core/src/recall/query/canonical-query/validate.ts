import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import {
  CANONICAL_QUERY_LIMITS,
  CANONICAL_QUERY_OPERATOR_ID,
  CanonicalQueryContractError,
  type CanonicalAnswerProgramV1,
  type CanonicalCompletionV1,
  type CanonicalConstraintV1,
  type CanonicalPredicateV1,
  type CanonicalQueryUnsupportedCode,
  type CanonicalQueryV1,
  type CanonicalQueryValidationV1,
  type CanonicalVariableV1
} from "./types.js";

export type CanonicalQueryInputV1 = Readonly<{
  readonly variables: readonly CanonicalVariableV1[];
  readonly predicates?: readonly CanonicalPredicateV1[];
  readonly constraints?: readonly CanonicalConstraintV1[];
  readonly answer?: CanonicalAnswerProgramV1;
  readonly answers?: readonly CanonicalAnswerProgramV1[];
  readonly unsupported?: "count" | "sum" | "latest" | "earliest" | "nesting";
}>;

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
  const predicates = freezeAtoms(input.predicates ?? [], "predicate");
  const constraints = freezeAtoms(input.constraints ?? [], "constraint");
  assertLimits(variables, predicates, constraints, input.answer);
  const names = new Map(variables.map((variable) => [variable.name, variable]));
  bindPhi(predicates, constraints, names);
  bindAnswer(input.answer, names, { extrema: 0, depth: 0 });
  const query = Object.freeze({
    schema_version: 1 as const,
    operator_id: CANONICAL_QUERY_OPERATOR_ID,
    variables,
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

function freezeVariables(
  variables: readonly CanonicalVariableV1[]
): readonly CanonicalVariableV1[] {
  const names = new Set<string>();
  return Object.freeze(variables.map((variable) => {
    const name = requireToken(variable.name);
    if (names.has(name)) throw new CanonicalQueryContractError("undeclared_variable");
    names.add(name);
    return Object.freeze({ name, sort: variable.sort });
  }));
}

function freezeAtoms<T extends { readonly id: string; readonly arguments: readonly string[] }>(
  atoms: readonly T[],
  label: "predicate" | "constraint"
): readonly T[] {
  const ids = new Set<string>();
  return Object.freeze(atoms.map((atom) => {
    const id = requireToken(atom.id);
    if (ids.has(id)) throw new CanonicalQueryContractError("limit_overflow", label);
    ids.add(id);
    return Object.freeze({
      ...atom,
      id,
      arguments: Object.freeze(atom.arguments.map(requireToken))
    }) as T;
  }));
}

function assertLimits(
  variables: readonly CanonicalVariableV1[],
  predicates: readonly CanonicalPredicateV1[],
  constraints: readonly CanonicalConstraintV1[],
  answer: CanonicalAnswerProgramV1
): void {
  if (variables.length > CANONICAL_QUERY_LIMITS.max_variables) {
    throw new CanonicalQueryContractError("limit_overflow", "variables");
  }
  if (predicates.length + constraints.length
    > CANONICAL_QUERY_LIMITS.max_predicates_and_constraints) {
    throw new CanonicalQueryContractError("limit_overflow", "phi");
  }
  if (answerDepth(answer) > CANONICAL_QUERY_LIMITS.max_depth) {
    throw new CanonicalQueryContractError("limit_overflow", "depth");
  }
}

function bindPhi(
  predicates: readonly CanonicalPredicateV1[],
  constraints: readonly CanonicalConstraintV1[],
  names: ReadonlyMap<string, CanonicalVariableV1>
): void {
  for (const atom of [...predicates, ...constraints]) {
    for (const argument of atom.arguments) requireVariable(argument, names);
  }
}

function bindAnswer(
  answer: CanonicalAnswerProgramV1,
  names: ReadonlyMap<string, CanonicalVariableV1>,
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

function requireVariable(
  name: string,
  names: ReadonlyMap<string, CanonicalVariableV1>
): CanonicalVariableV1 {
  const variable = names.get(name);
  if (variable === undefined) {
    throw new CanonicalQueryContractError("undeclared_variable");
  }
  return variable;
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

function freezeCompletion(completion: CanonicalCompletionV1): CanonicalCompletionV1 {
  if (completion.kind === "at_most") {
    if (!Number.isSafeInteger(completion.n) || completion.n < 1) {
      throw new CanonicalQueryContractError("limit_overflow", "at_most");
    }
    return Object.freeze({ kind: "at_most", n: completion.n });
  }
  if (completion.snapshot_bind !== "Sigma_q") {
    throw new CanonicalQueryContractError("invalid_all_observable");
  }
  return Object.freeze({
    kind: "all_observable" as const,
    scope: requireToken(completion.scope),
    principal: requireToken(completion.principal),
    snapshot_bind: "Sigma_q" as const,
    observer_contract: requireToken(completion.observer_contract)
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
