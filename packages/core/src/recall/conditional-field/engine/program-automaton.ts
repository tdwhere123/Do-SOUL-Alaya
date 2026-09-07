import type { QueryProgram } from "@do-soul/alaya-protocol";

export const ACCEPTING_PROGRAM_STATE = "accepting";
export const START_PROGRAM_STATE = "start";

type QueryRelation = Extract<QueryProgram, { readonly kind: "relation" }>;

export type AutomatonAdvance = Readonly<{
  readonly from: string;
  readonly relation: QueryRelation;
  readonly to: readonly string[];
}>;

export type HyperedgeAdvance = Readonly<{
  readonly from: string;
  readonly hyperedge: Extract<QueryProgram, { readonly kind: "hyperedge" }>;
  readonly to: readonly string[];
}>;

export type ProgramAutomaton = Readonly<{
  readonly start: readonly string[];
  readonly advances: readonly AutomatonAdvance[];
  readonly hyperedgeAdvances: readonly HyperedgeAdvance[];
  readonly sourceVariables: ReadonlyMap<string, readonly string[]>;
  readonly localVariables: ReadonlyMap<string, readonly string[]>;
}>;

type Fragment = Readonly<{
  readonly start: string;
  readonly accept: string;
}>;

type Builder = {
  next: number;
  readonly eps: Map<string, string[]>;
  readonly advances: AutomatonAdvance[];
  readonly hyperedgeAdvances: HyperedgeAdvance[];
  readonly locals: Map<string, readonly string[]>;
};

export function compileProgramAutomaton(program: QueryProgram): ProgramAutomaton {
  if (program.kind === "empty") return emptyAutomaton();
  if (program.kind === "epsilon") return epsilonAutomaton();
  const builder: Builder = { next: 0, eps: new Map(), advances: [], hyperedgeAdvances: [], locals: new Map() };
  const fragment = compileFragment(program, builder);
  addEps(builder, fragment.accept, ACCEPTING_PROGRAM_STATE);
  const start = liveStates(builder, epsilonClosure(builder.eps, [fragment.start]));
  const advances = closeAdvances(builder);
  const hyperedgeAdvances = closeHyperedgeAdvances(builder);
  return {
    start,
    advances,
    hyperedgeAdvances,
    sourceVariables: sourceVariablesFrom(advances, hyperedgeAdvances),
    localVariables: builder.locals
  };
}

export function advancesFor(
  automaton: ProgramAutomaton,
  fromState: string,
  matches: (relation: QueryRelation) => boolean
): readonly AutomatonAdvance[] {
  return automaton.advances.filter((advance) =>
    advance.from === fromState && matches(advance.relation)
  );
}

function emptyAutomaton(): ProgramAutomaton {
  return {
    start: [],
    advances: [],
    hyperedgeAdvances: [],
    sourceVariables: new Map(),
    localVariables: new Map()
  };
}

function epsilonAutomaton(): ProgramAutomaton {
  return {
    start: [ACCEPTING_PROGRAM_STATE],
    advances: [],
    hyperedgeAdvances: [],
    sourceVariables: new Map(),
    localVariables: new Map()
  };
}

function compileFragment(program: QueryProgram, builder: Builder): Fragment {
  switch (program.kind) {
    case "epsilon":
      return compileEpsilon(builder);
    case "empty":
      return compileEmpty(builder);
    case "relation":
      return compileRelation(program, builder);
    case "sequence":
      return compileSequence(program.steps, builder);
    case "alternative":
      return compileAlternative(program.options, builder);
    case "repeat":
      return compileRepeat(program, builder);
    case "closure":
      return compileClosure(program.body, builder, program.local_variables ?? []);
    case "hyperedge":
      return compileHyperedge(program, builder);
  }
}

function compileEpsilon(builder: Builder): Fragment {
  const state = fresh(builder, "eps");
  return { start: state, accept: state };
}

function compileEmpty(builder: Builder): Fragment {
  return { start: fresh(builder, "emp"), accept: fresh(builder, "emp") };
}

function compileRelation(program: QueryRelation, builder: Builder): Fragment {
  const start = fresh(builder, "rel");
  const accept = fresh(builder, "rel");
  builder.advances.push({ from: start, relation: program, to: [accept] });
  return { start, accept };
}

function compileSequence(steps: readonly QueryProgram[], builder: Builder): Fragment {
  const first = compileFragment(steps[0] ?? { schema_version: 1, kind: "empty" }, builder);
  let accept = first.accept;
  for (const step of steps.slice(1)) {
    const next = compileFragment(step, builder);
    addEps(builder, accept, next.start);
    accept = next.accept;
  }
  return { start: first.start, accept };
}

function compileAlternative(options: readonly QueryProgram[], builder: Builder): Fragment {
  const start = fresh(builder, "alt");
  const accept = fresh(builder, "alt");
  for (const option of options) {
    const inner = compileFragment(option, builder);
    addEps(builder, start, inner.start);
    addEps(builder, inner.accept, accept);
  }
  return { start, accept };
}

function compileHyperedge(
  program: Extract<QueryProgram, { readonly kind: "hyperedge" }>,
  builder: Builder
): Fragment {
  const start = fresh(builder, "hyp");
  const accept = fresh(builder, "hyp");
  builder.hyperedgeAdvances.push({ from: start, hyperedge: program, to: [accept] });
  return { start, accept };
}

function compileRepeat(program: Extract<QueryProgram, { kind: "repeat" }>, builder: Builder): Fragment {
  let first: Fragment | undefined;
  let prior: Fragment | undefined;
  for (let i = 0; i < program.count; i += 1) {
    const inner = compileFragment(program.body, builder);
    for (const state of liveStates(builder, epsilonClosure(builder.eps, [inner.start]))) {
      builder.locals.set(state, program.local_variables ?? []);
    }
    if (prior !== undefined) addEps(builder, prior.accept, inner.start);
    first ??= inner;
    prior = inner;
  }
  return first === undefined || prior === undefined ? compileEpsilon(builder) : { start: first.start, accept: prior.accept };
}

function compileClosure(body: QueryProgram, builder: Builder, locals: readonly string[]): Fragment {
  const inner = compileFragment(body, builder);
  for (const state of liveStates(builder, epsilonClosure(builder.eps, [inner.start]))) {
    builder.locals.set(state, locals);
  }
  const start = fresh(builder, "clo");
  const accept = fresh(builder, "clo");
  addEps(builder, start, inner.start);
  addEps(builder, start, accept);
  addEps(builder, inner.accept, accept);
  addEps(builder, inner.accept, inner.start);
  return { start, accept };
}

function closeAdvances(builder: Builder): readonly AutomatonAdvance[] {
  return Object.freeze(builder.advances.map((advance) => ({
    from: advance.from,
    relation: advance.relation,
    to: liveStates(builder, epsilonClosure(builder.eps, advance.to))
  })));
}

function closeHyperedgeAdvances(builder: Builder): readonly HyperedgeAdvance[] {
  return Object.freeze(builder.hyperedgeAdvances.map((advance) => ({
    from: advance.from,
    hyperedge: advance.hyperedge,
    to: liveStates(builder, epsilonClosure(builder.eps, advance.to))
  })));
}

function liveStates(builder: Builder, states: readonly string[]): readonly string[] {
  const outgoing = new Set([
    ...builder.advances.map((advance) => advance.from),
    ...builder.hyperedgeAdvances.map((advance) => advance.from)
  ]);
  return Object.freeze(states.filter((state) =>
    state === ACCEPTING_PROGRAM_STATE || outgoing.has(state)
  ));
}

function sourceVariablesFrom(
  advances: readonly AutomatonAdvance[],
  hyperedgeAdvances: readonly HyperedgeAdvance[]
): ReadonlyMap<string, readonly string[]> {
  const byState = new Map<string, string[]>();
  for (const advance of advances) {
    addSourceVariable(byState, advance.from, advance.relation.source_variable);
  }
  for (const advance of hyperedgeAdvances) {
    for (const variable of sourceVariablesOf(advance.hyperedge)) {
      addSourceVariable(byState, advance.from, variable);
    }
  }
  return byState;
}

function addSourceVariable(
  byState: Map<string, string[]>,
  state: string,
  variable: string
): void {
  const existing = byState.get(state) ?? [];
  if (!existing.includes(variable)) existing.push(variable);
  byState.set(state, existing);
}

function sourceVariablesOf(program: QueryProgram): readonly string[] {
  switch (program.kind) {
    case "relation":
      return [program.source_variable];
    case "sequence":
      return sourceVariablesOf(program.steps[0] ?? { schema_version: 1, kind: "empty" });
    case "alternative":
      return unique(program.options.flatMap((option) => sourceVariablesOf(option)));
    case "repeat":
    case "closure":
      return sourceVariablesOf(program.body);
    case "hyperedge":
      return unique(program.premises.flatMap((premise) => sourceVariablesOf(premise)));
    default:
      return [];
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function addEps(builder: Builder, from: string, to: string): void {
  const existing = builder.eps.get(from);
  if (existing === undefined) builder.eps.set(from, [to]);
  else if (!existing.includes(to)) existing.push(to);
}

function epsilonClosure(eps: ReadonlyMap<string, readonly string[]>, seeds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const state = stack.pop();
    if (state === undefined || seen.has(state)) continue;
    seen.add(state);
    for (const next of eps.get(state) ?? []) stack.push(next);
  }
  return [...seen];
}

function fresh(builder: Builder, hint: string): string {
  builder.next += 1;
  return `${hint}${String(builder.next)}`;
}
