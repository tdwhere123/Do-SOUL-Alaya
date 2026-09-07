import type {
  CompletenessReport,
  CompletenessStatus,
  Guard,
  QueryHole,
  QueryHypothesis,
  QueryInterpretationStatus,
  QueryProgram
} from "@do-soul/alaya-protocol";

export type InterpretQueryResult =
  | { readonly kind: "epsilon" }
  | { readonly kind: "empty" }
  | { readonly kind: "program"; readonly program: QueryProgram }
  | { readonly kind: "unsupported" };

export type InterpretQueryOptions = Readonly<{
  readonly productKeySufficient?: boolean;
}>;

export function guardAppliesToVariable(guard: Guard, variable: string): boolean {
  if (guard.time_scope === "none") return false;
  if (guard.variable === undefined) return false;
  return guard.variable === variable;
}

export function interpretationMayEmitCompleteEmpty(
  status: QueryInterpretationStatus
): boolean {
  return status === "resolved";
}

export function interpretationCoverageFor(
  status: QueryInterpretationStatus,
  interpretation?: Readonly<{
    readonly hypotheses?: readonly QueryHypothesis[];
    readonly holes?: readonly QueryHole[];
  }>
): CompletenessStatus {
  if (status === "resource_rejected") return "resource_rejected";
  if (status === "unsupported" || status === "malformed") return "unavailable";
  if (status === "hypotheses" || (interpretation?.hypotheses?.length ?? 0) > 0) return "open";
  if (status === "partial" || (interpretation?.holes ?? []).some((hole) => hole.status !== "bound")) {
    return "open";
  }
  return "complete";
}

export function completenessForInterpretationStatus(
  status: QueryInterpretationStatus
): CompletenessReport | undefined {
  // Hypotheses/partial stay undefined here so the engine does not treat them as envelope rejection.
  if (status === "resource_rejected") {
    return {
      schema_version: 1,
      logical_index: "resource_rejected",
      observed_coverage: "resource_rejected",
      interpretation_coverage: "resource_rejected",
      transport: "resource_rejected",
      payload: "resource_rejected",
      representation: "resource_rejected"
    };
  }
  if (status === "unsupported" || status === "malformed") {
    return {
      schema_version: 1,
      logical_index: "unavailable",
      observed_coverage: "unavailable",
      interpretation_coverage: "unavailable",
      transport: "unavailable",
      payload: "unavailable",
      representation: "unavailable"
    };
  }
  return undefined;
}

export function interpretQuery(
  program: QueryProgram,
  options: InterpretQueryOptions = {}
): InterpretQueryResult {
  switch (program.kind) {
    case "epsilon":
      return { kind: "epsilon" };
    case "empty":
      return { kind: "empty" };
    case "relation":
      return { kind: "program", program };
    case "sequence":
      return interpretSequence(program.steps, options);
    case "alternative":
      return interpretAlternative(program.options, options);
    case "repeat":
      return interpretRepeat(program.count, program.body, options);
    case "closure":
      return interpretClosure(program, options);
    case "hyperedge":
      return interpretHyperedge(program, options);
  }
}

function interpretSequence(
  steps: readonly QueryProgram[],
  options: InterpretQueryOptions
): InterpretQueryResult {
  const kept: InterpretQueryResult[] = [];
  for (const step of steps) {
    const result = interpretQuery(step, options);
    if (result.kind === "unsupported") return result;
    if (result.kind === "empty") return { kind: "empty" };
    if (result.kind !== "epsilon") kept.push(result);
  }
  if (kept.length === 0) return { kind: "epsilon" };
  if (kept.length === 1) return kept[0] ?? { kind: "unsupported" };
  return programResult({
    schema_version: 1,
    kind: "sequence",
    steps: kept.flatMap(asPrograms)
  });
}

function interpretAlternative(
  options: readonly QueryProgram[],
  interpretOptions: InterpretQueryOptions
): InterpretQueryResult {
  const kept: InterpretQueryResult[] = [];
  for (const option of options) {
    const result = interpretQuery(option, interpretOptions);
    if (result.kind === "unsupported") return result;
    if (result.kind !== "empty") kept.push(result);
  }
  if (kept.length === 0) return { kind: "empty" };
  if (kept.length === 1) return kept[0] ?? { kind: "unsupported" };
  return programResult({
    schema_version: 1,
    kind: "alternative",
    options: kept.flatMap(asPrograms)
  });
}

function interpretRepeat(
  count: number,
  body: QueryProgram,
  options: InterpretQueryOptions
): InterpretQueryResult {
  if (count < 1 || count > 8) return { kind: "unsupported" };
  return interpretSequence(Array.from({ length: count }, () => body), options);
}

function interpretClosure(
  program: Extract<QueryProgram, { readonly kind: "closure" }>,
  options: InterpretQueryOptions
): InterpretQueryResult {
  if (program.product_state_sufficient !== true) return { kind: "unsupported" };
  if (options.productKeySufficient !== true) return { kind: "program", program };
  return interpretQuery(program.body, options);
}

function interpretHyperedge(
  program: Extract<QueryProgram, { readonly kind: "hyperedge" }>,
  options: InterpretQueryOptions
): InterpretQueryResult {
  const premises: QueryProgram[] = [];
  for (const premise of program.premises) {
    const result = interpretQuery(premise, options);
    if (result.kind === "unsupported") return result;
    const restored = asPrograms(result)[0];
    if (restored === undefined) return { kind: "unsupported" };
    premises.push(restored);
  }
  return programResult({
    schema_version: 1,
    kind: "hyperedge",
    join: program.join,
    premises
  });
}

function programResult(program: QueryProgram): InterpretQueryResult {
  return { kind: "program", program };
}

function asPrograms(result: InterpretQueryResult): readonly QueryProgram[] {
  if (result.kind === "epsilon") return [{ schema_version: 1, kind: "epsilon" }];
  if (result.kind === "empty") return [{ schema_version: 1, kind: "empty" }];
  if (result.kind === "program") return [result.program];
  return [];
}
