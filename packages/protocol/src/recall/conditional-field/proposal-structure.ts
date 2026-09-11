// Iterative so a skinny nested proposal cannot recurse through z.lazy QueryProgram decode.
export const QUERY_PROPOSAL_MAX_AST_DEPTH = 32;
export const QUERY_PROPOSAL_MAX_AST_NODES = 4096;
export const QUERY_PROPOSAL_MAX_TOTAL_GUARDS = 1024;
export const QUERY_PROPOSAL_MAX_TOTAL_PREDICATES = 1024;
export const QUERY_PROPOSAL_MAX_TOTAL_HYPOTHESES = 256;
export const QUERY_PROPOSAL_MAX_REQUEST_BYTES = 1_048_576;

export const QUERY_PROPOSAL_PROGRAM_KINDS = [
  "epsilon",
  "empty",
  "relation",
  "sequence",
  "alternative",
  "repeat",
  "closure",
  "hyperedge"
] as const;

export const QUERY_PROPOSAL_GUARD_KINDS = [
  "equality",
  "source_bound_entity",
  "interval_relation",
  "authorization",
  "query_predicate"
] as const;

const PROGRAM_KIND_SET: ReadonlySet<string> = new Set(QUERY_PROPOSAL_PROGRAM_KINDS);
const GUARD_KIND_SET: ReadonlySet<string> = new Set(QUERY_PROPOSAL_GUARD_KINDS);

export type QueryProposalProgramKind = (typeof QUERY_PROPOSAL_PROGRAM_KINDS)[number];
export type QueryProposalGuardKind = (typeof QUERY_PROPOSAL_GUARD_KINDS)[number];

export type QueryProposalStructuralLimits = Readonly<{
  readonly max_ast_depth: number;
  readonly max_ast_nodes: number;
  readonly max_total_guards: number;
  readonly max_total_predicates: number;
  readonly max_total_hypotheses: number;
  readonly max_request_bytes: number;
}>;

export const QUERY_PROPOSAL_TRANSPORT_LIMITS: QueryProposalStructuralLimits = Object.freeze({
  max_ast_depth: QUERY_PROPOSAL_MAX_AST_DEPTH,
  max_ast_nodes: QUERY_PROPOSAL_MAX_AST_NODES,
  max_total_guards: QUERY_PROPOSAL_MAX_TOTAL_GUARDS,
  max_total_predicates: QUERY_PROPOSAL_MAX_TOTAL_PREDICATES,
  max_total_hypotheses: QUERY_PROPOSAL_MAX_TOTAL_HYPOTHESES,
  max_request_bytes: QUERY_PROPOSAL_MAX_REQUEST_BYTES
});

export type QueryProposalStructureCounts = Readonly<{
  readonly ast_depth: number;
  readonly ast_nodes: number;
  readonly total_guards: number;
  readonly total_predicates: number;
  readonly total_hypotheses: number;
  readonly request_bytes: number;
}>;

export type QueryProposalStructureInspection =
  | { readonly kind: "ok"; readonly counts: QueryProposalStructureCounts }
  | {
      readonly kind: "reject";
      readonly reason: "depth" | "nodes" | "guards" | "predicates" | "hypotheses" | "bytes" | "invalid";
      readonly message: string;
    };

type WalkFrame = Readonly<{
  readonly value: unknown;
  readonly depth: number;
  readonly region: "program" | "conditions" | "hypotheses" | "guard" | "json";
}>;

export function tightenQueryProposalLimits(
  server: QueryProposalStructuralLimits,
  ...caps: ReadonlyArray<Partial<QueryProposalStructuralLimits> | undefined>
): QueryProposalStructuralLimits {
  let limits = server;
  for (const cap of caps) {
    if (cap === undefined) continue;
    limits = {
      max_ast_depth: minBound(limits.max_ast_depth, cap.max_ast_depth),
      max_ast_nodes: minBound(limits.max_ast_nodes, cap.max_ast_nodes),
      max_total_guards: minBound(limits.max_total_guards, cap.max_total_guards),
      max_total_predicates: minBound(limits.max_total_predicates, cap.max_total_predicates),
      max_total_hypotheses: minBound(limits.max_total_hypotheses, cap.max_total_hypotheses),
      max_request_bytes: minBound(limits.max_request_bytes, cap.max_request_bytes)
    };
  }
  return limits;
}

export function inspectQueryProposalStructure(
  value: unknown,
  limits: QueryProposalStructuralLimits = QUERY_PROPOSAL_TRANSPORT_LIMITS
): QueryProposalStructureInspection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return rejected("invalid", "query interpretation proposal must be an object");
  }
  const proposal = value as Record<string, unknown>;
  const hypotheses = Array.isArray(proposal.hypotheses) ? proposal.hypotheses.length : 0;
  if (hypotheses > limits.max_total_hypotheses) {
    return rejected("hypotheses", `query proposal hypotheses exceed ${limits.max_total_hypotheses}`);
  }
  const stack: WalkFrame[] = [];
  if (proposal.program !== undefined) {
    stack.push({ value: proposal.program, depth: 1, region: "program" });
  }
  if (proposal.conditions !== undefined) {
    stack.push({ value: proposal.conditions, depth: 1, region: "conditions" });
  }
  if (proposal.hypotheses !== undefined) {
    stack.push({ value: proposal.hypotheses, depth: 1, region: "hypotheses" });
  }
  let astDepth = 0;
  let astNodes = 0;
  let guards = 0;
  let predicates = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.depth > limits.max_ast_depth) {
      return rejected("depth", `query proposal AST depth exceeds ${limits.max_ast_depth}`);
    }
    if (frame.depth > astDepth) astDepth = frame.depth;
    const current = frame.value;
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index], depth: frame.depth + 1, region: frame.region });
      }
      continue;
    }
    const record = current as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    if (frame.region === "program" && kind !== undefined && PROGRAM_KIND_SET.has(kind)) {
      astNodes += 1;
      if (astNodes > limits.max_ast_nodes) {
        return rejected("nodes", `query proposal AST nodes exceed ${limits.max_ast_nodes}`);
      }
      pushProgramChildren(stack, record, kind, frame.depth);
      continue;
    }
    if (kind !== undefined && GUARD_KIND_SET.has(kind)) {
      const counted = countGuard(kind, limits, guards, predicates);
      if (counted.kind !== "counted") return counted;
      guards = counted.nextGuards;
      predicates = counted.nextPredicates;
      pushJsonChildren(stack, record, frame.depth, "guard");
      continue;
    }
    pushJsonChildren(stack, record, frame.depth, frame.region === "program" ? "json" : frame.region);
  }
  const requestBytes = proposalRequestBytes(value);
  if (requestBytes === undefined) {
    return rejected("bytes", "query interpretation proposal is not JSON-serializable");
  }
  if (requestBytes > limits.max_request_bytes) {
    return rejected("bytes", `query proposal exceeds ${limits.max_request_bytes} bytes`);
  }
  return {
    kind: "ok",
    counts: {
      ast_depth: astDepth,
      ast_nodes: astNodes,
      total_guards: guards,
      total_predicates: predicates,
      total_hypotheses: hypotheses,
      request_bytes: requestBytes
    }
  };
}

function countGuard(
  kind: string,
  limits: QueryProposalStructuralLimits,
  guards: number,
  predicates: number
):
  | Extract<QueryProposalStructureInspection, { kind: "reject" }>
  | { readonly kind: "counted"; readonly nextGuards: number; readonly nextPredicates: number }
{
  const nextGuards = guards + 1;
  if (nextGuards > limits.max_total_guards) {
    return rejected("guards", `query proposal guards exceed ${limits.max_total_guards}`);
  }
  if (kind !== "query_predicate") {
    return { kind: "counted", nextGuards, nextPredicates: predicates };
  }
  const nextPredicates = predicates + 1;
  if (nextPredicates > limits.max_total_predicates) {
    return rejected("predicates", `query proposal predicates exceed ${limits.max_total_predicates}`);
  }
  return { kind: "counted", nextGuards, nextPredicates };
}

function pushProgramChildren(
  stack: WalkFrame[],
  record: Record<string, unknown>,
  kind: string,
  depth: number
): void {
  if (kind === "sequence" && Array.isArray(record.steps)) {
    pushAll(stack, record.steps, depth + 1, "program");
    return;
  }
  if (kind === "alternative" && Array.isArray(record.options)) {
    pushAll(stack, record.options, depth + 1, "program");
    return;
  }
  if ((kind === "repeat" || kind === "closure") && record.body !== undefined) {
    stack.push({ value: record.body, depth: depth + 1, region: "program" });
    return;
  }
  if (kind === "hyperedge" && Array.isArray(record.premises)) {
    pushAll(stack, record.premises, depth + 1, "program");
    return;
  }
  if (kind === "relation" && record.guard !== undefined) {
    stack.push({ value: record.guard, depth: depth + 1, region: "guard" });
  }
}

function pushJsonChildren(
  stack: WalkFrame[],
  record: Record<string, unknown>,
  depth: number,
  region: WalkFrame["region"]
): void {
  for (const nested of Object.values(record)) {
    if (nested !== null && typeof nested === "object") {
      stack.push({ value: nested, depth: depth + 1, region });
    }
  }
}

function pushAll(
  stack: WalkFrame[],
  values: readonly unknown[],
  depth: number,
  region: WalkFrame["region"]
): void {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    stack.push({ value: values[index], depth, region });
  }
}

function proposalRequestBytes(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
}

function minBound(left: number, right: number | undefined): number {
  return right === undefined ? left : Math.min(left, right);
}

function rejected(
  reason: Exclude<QueryProposalStructureInspection, { kind: "ok" }>["reason"],
  message: string
): Extract<QueryProposalStructureInspection, { kind: "reject" }> {
  return { kind: "reject", reason, message };
}
