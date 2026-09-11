import {
  QUERY_PROPOSAL_GUARD_KINDS,
  QUERY_PROPOSAL_PROGRAM_KINDS,
  QueryInterpretationProposalSchema,
  inspectQueryProposalStructure,
  type Guard,
  type ProposedGuard,
  type ProposedQueryProgram,
  type QueryHole,
  type QueryHypothesis,
  type QueryInterpretationProposal,
  type QueryProgram,
  type QueryProposalStructuralLimits
} from "@do-soul/alaya-protocol";
import { proposalBindsOriginalQuery } from "./compile-query-identity.js";
import {
  defaultQueryProposalProducerRegistry,
  effectiveQueryProposalLimits,
  producerVersionOf,
  type QueryProposalProducerCapability,
  type QueryProposalProducerRecord,
  type QueryProposalProducerRegistry
} from "./query-proposal-producer-registry.js";

const GUARD_KIND_SET: ReadonlySet<string> = new Set(QUERY_PROPOSAL_GUARD_KINDS);
const PROGRAM_KIND_SET: ReadonlySet<string> = new Set(QUERY_PROPOSAL_PROGRAM_KINDS);

export type QueryProposalAdmission =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "unsupported" | "resource_rejected" | "malformed";
      readonly proposal: QueryInterpretationProposal;
      readonly stored_proposal: QueryInterpretationProposal;
      readonly effective_limits: QueryProposalStructuralLimits;
    }
  | {
      readonly kind: "admitted";
      readonly proposal: QueryInterpretationProposal;
      readonly stored_proposal: QueryInterpretationProposal;
      readonly program: QueryProgram | undefined;
      readonly conditions: readonly Guard[];
      readonly holes: readonly QueryHole[] | undefined;
      readonly hypotheses: readonly QueryHypothesis[] | undefined;
      readonly effective_limits: QueryProposalStructuralLimits;
      readonly producer: QueryProposalProducerRecord;
    };

export function admitQueryProposal(
  proposal: QueryInterpretationProposal | undefined,
  originalQuery: string,
  registry: QueryProposalProducerRegistry = defaultQueryProposalProducerRegistry
): QueryProposalAdmission {
  if (proposal === undefined) return { kind: "absent" };
  if (!proposalBindsOriginalQuery(proposal, originalQuery)) return { kind: "invalid" };
  const producer = registry.lookup(proposal.producer_id, producerVersionOf(proposal));
  const effectiveLimits = effectiveQueryProposalLimits(producer, proposal.input_limits);
  const structure = inspectQueryProposalStructure(proposal, effectiveLimits);
  if (structure.kind !== "ok") {
    return rejected("resource_rejected", proposal, effectiveLimits, false);
  }
  if (producer === undefined || !producerMatchesProposal(producer, proposal)) {
    return rejected("unsupported", proposal, effectiveLimits, true);
  }
  if (proposalCarriesFinalGuardVerdict(proposal)) {
    return rejected("malformed", proposal, effectiveLimits, true);
  }
  return {
    kind: "admitted",
    proposal,
    stored_proposal: stripProposalVerdicts(proposal),
    program: proposal.program === undefined ? undefined : admitProposedProgram(proposal.program),
    conditions: (proposal.conditions ?? []).map(admitProposedGuard),
    holes: proposal.holes,
    hypotheses: proposal.hypotheses,
    effective_limits: effectiveLimits,
    producer
  };
}

export function admitProposedGuard(guard: ProposedGuard | Guard): Guard {
  return {
    schema_version: guard.schema_version,
    kind: guard.kind,
    verdict: "unresolved",
    ...(guard.variable === undefined ? {} : { variable: guard.variable }),
    ...(guard.time_scope === undefined ? {} : { time_scope: guard.time_scope }),
    ...(guard.equals_variable === undefined ? {} : { equals_variable: guard.equals_variable }),
    ...(guard.entity_id === undefined ? {} : { entity_id: guard.entity_id }),
    ...(guard.interval === undefined ? {} : { interval: guard.interval }),
    ...(guard.predicate_name === undefined ? {} : { predicate_name: guard.predicate_name }),
    ...(guard.authorization_scope === undefined ? {} : { authorization_scope: guard.authorization_scope })
  };
}

export function admitProposedProgram(program: ProposedQueryProgram | QueryProgram): QueryProgram {
  switch (program.kind) {
    case "epsilon":
    case "empty":
      return program;
    case "relation":
      return { ...program, guard: admitProposedGuard(program.guard) };
    case "sequence":
      return { ...program, steps: program.steps.map(admitProposedProgram) };
    case "alternative":
      return { ...program, options: program.options.map(admitProposedProgram) };
    case "repeat":
    case "closure":
      return { ...program, body: admitProposedProgram(program.body) };
    case "hyperedge":
      return { ...program, premises: program.premises.map(admitProposedProgram) };
  }
}

export function stripProposalVerdicts(
  proposal: QueryInterpretationProposal
): QueryInterpretationProposal {
  return {
    ...proposal,
    producer_version: producerVersionOf(proposal),
    ...(proposal.conditions === undefined
      ? {}
      : { conditions: proposal.conditions.map(asProposedGuard) }),
    ...(proposal.program === undefined ? {} : { program: stripProgramVerdicts(proposal.program) })
  };
}

function rejected(
  kind: "unsupported" | "resource_rejected" | "malformed",
  proposal: QueryInterpretationProposal,
  effectiveLimits: QueryProposalStructuralLimits,
  includeAst: boolean
): QueryProposalAdmission {
  const stored = includeAst ? stripProposalVerdicts(proposal) : envelopeProposal(proposal);
  return {
    kind,
    proposal,
    stored_proposal: QueryInterpretationProposalSchema.safeParse(stored).success
      ? stored
      : envelopeProposal(proposal),
    effective_limits: effectiveLimits
  };
}

function envelopeProposal(proposal: QueryInterpretationProposal): QueryInterpretationProposal {
  return {
    schema_version: proposal.schema_version,
    original_query_digest: proposal.original_query_digest,
    producer_id: proposal.producer_id,
    producer_version: producerVersionOf(proposal),
    ...(proposal.stored_cosine_admission === undefined
      ? {}
      : { stored_cosine_admission: proposal.stored_cosine_admission }),
    ...(proposal.input_limits === undefined ? {} : { input_limits: proposal.input_limits })
  };
}

function producerMatchesProposal(
  producer: QueryProposalProducerRecord,
  proposal: QueryInterpretationProposal
): boolean {
  if (!capabilityAllows(producer, "program", proposal.program !== undefined)) return false;
  if (!capabilityAllows(producer, "conditions", (proposal.conditions?.length ?? 0) > 0)) return false;
  if (!capabilityAllows(producer, "holes", (proposal.holes?.length ?? 0) > 0)) return false;
  if (!capabilityAllows(producer, "hypotheses", (proposal.hypotheses?.length ?? 0) > 0)) return false;
  if (!capabilityAllows(producer, "stored_cosine_admission", proposal.stored_cosine_admission !== undefined)) {
    return false;
  }
  if (proposal.program === undefined) return true;
  const allowed = new Set<string>(producer.allowed_grammar);
  const stack: unknown[] = [proposal.program];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.kind === "string" && PROGRAM_KIND_SET.has(record.kind) && !allowed.has(record.kind)) {
      return false;
    }
    for (const nested of Object.values(record)) {
      if (nested !== null && typeof nested === "object") stack.push(nested);
    }
  }
  return true;
}

function capabilityAllows(
  producer: QueryProposalProducerRecord,
  capability: QueryProposalProducerCapability,
  present: boolean
): boolean {
  return !present || producer.capabilities.includes(capability);
}

function proposalCarriesFinalGuardVerdict(proposal: QueryInterpretationProposal): boolean {
  const stack: unknown[] = [];
  if (proposal.program !== undefined) stack.push(proposal.program);
  if (proposal.conditions !== undefined) stack.push(proposal.conditions);
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (
      typeof record.kind === "string"
      && GUARD_KIND_SET.has(record.kind)
      && (record.verdict === "true" || record.verdict === "false")
    ) {
      return true;
    }
    for (const nested of Object.values(record)) {
      if (nested !== null && typeof nested === "object") stack.push(nested);
    }
  }
  return false;
}

function stripProgramVerdicts(program: ProposedQueryProgram | QueryProgram): ProposedQueryProgram {
  switch (program.kind) {
    case "epsilon":
    case "empty":
      return program;
    case "relation":
      return { ...program, guard: asProposedGuard(program.guard) };
    case "sequence":
      return { ...program, steps: program.steps.map(stripProgramVerdicts) };
    case "alternative":
      return { ...program, options: program.options.map(stripProgramVerdicts) };
    case "repeat":
    case "closure":
      return { ...program, body: stripProgramVerdicts(program.body) };
    case "hyperedge":
      return { ...program, premises: program.premises.map(stripProgramVerdicts) };
  }
}

function asProposedGuard(guard: ProposedGuard | Guard): ProposedGuard {
  const admitted = admitProposedGuard(guard);
  return {
    schema_version: admitted.schema_version,
    kind: admitted.kind,
    ...(admitted.variable === undefined ? {} : { variable: admitted.variable }),
    ...(admitted.time_scope === undefined ? {} : { time_scope: admitted.time_scope }),
    ...(admitted.equals_variable === undefined ? {} : { equals_variable: admitted.equals_variable }),
    ...(admitted.entity_id === undefined ? {} : { entity_id: admitted.entity_id }),
    ...(admitted.interval === undefined ? {} : { interval: admitted.interval }),
    ...(admitted.predicate_name === undefined ? {} : { predicate_name: admitted.predicate_name }),
    ...(admitted.authorization_scope === undefined
      ? {}
      : { authorization_scope: admitted.authorization_scope })
  };
}
