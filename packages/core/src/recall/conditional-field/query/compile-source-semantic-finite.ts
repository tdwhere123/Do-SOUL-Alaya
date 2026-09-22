import {
  type QueryProgram, type SourceSemanticQuery, type SourceSemanticCorrespondence, type SourceSemanticInterpretation,
  type SourceSemanticResourceLedger, type SourceSemanticDomain
} from "@do-soul/alaya-protocol";
import { sourceSemanticRelationKey as key, correspondenceGroupPhases, type SourceSemanticPremisePopulation } from "../../runtime/source-semantic-premises.js";
import { compileSourceSemanticAlternative, compileSourceSemanticGroupProgram } from "./compile-source-semantic-query.js";
import { semanticRelation as rel, semanticSequence as sequence, semanticAlternatives as alternatives,
  semanticOwnerProof, emptySemanticProgram } from "./source-semantic-proof-program.js";

export type SourceSemanticProofBranch = Readonly<{ purpose: "support" | "counterexample" | "incomparable" | "empty_domain";
  alternative: number; candidate?: string; candidate_variable?: string }>;
export type SourceSemanticGroupPhase = Readonly<{
  program: QueryProgram; alternative: number; acceptIndex: number; groupFrame?: string;
}>;
export type SourceSemanticExecutionPlan = Readonly<{
  program: QueryProgram; branches: readonly SourceSemanticProofBranch[]; domain?: SourceSemanticDomain;
  missingOperands: boolean; missingMembership?: boolean;
  groupPhases?: readonly SourceSemanticGroupPhase[];
}>;
type Input = Readonly<{ source_interpretation: SourceSemanticInterpretation; query_semantics: SourceSemanticQuery; semantic_correspondence: SourceSemanticCorrespondence;
  population: SourceSemanticPremisePopulation; meter: SourceSemanticResourceLedger }>;
const DOMAIN = "@finite:domain";

/** Expand finite obligations only. Every outcome is still decided by the conditional-field engine. */
export function compileSourceSemanticExecution(input: Input): SourceSemanticExecutionPlan {
  const { query_semantics: querySemantics, source_interpretation: sourceInterpretation, semantic_correspondence: semanticCorrespondence, meter, population } = input;
  if (querySemantics.evaluation === undefined) {
    const finite = { source_interpretation: sourceInterpretation, population, semantic_correspondence: semanticCorrespondence };
    let acceptIndex = 0;
    const groupPhases = querySemantics.alternatives.flatMap((alternative, index) => {
      const frames = correspondenceGroupPhases(querySemantics, semanticCorrespondence, index);
      return frames.map((group) => {
        const phase = {
          program: compileSourceSemanticGroupProgram(querySemantics, alternative, index, meter, finite, group, acceptIndex),
          alternative: index, acceptIndex, groupFrame: group
        };
        acceptIndex += 1;
        return phase;
      });
    });
    const branches = groupPhases.map((phase) => ({ purpose: "support" as const, alternative: phase.alternative }));
    return {
      program: groupPhases[0]?.program ?? emptySemanticProgram,
      branches, missingOperands: false, groupPhases
    };
  }
  const mapping = semanticCorrespondence.domains?.find((row) => row.query_domain === querySemantics.evaluation!.domain);
  const domain = sourceInterpretation.domains?.find((row) => row.id === mapping?.source_domain);
  if (domain === undefined) return { program: emptySemanticProgram, branches: [], missingOperands: false };
  return querySemantics.evaluation.kind === "forall" ? compileUniversal(input, domain) : compileComparison(input, domain);
}

function domainEntry(input: Input, domain: SourceSemanticDomain): QueryProgram[] {
  return [rel(key("candidate_route"), "@finite:seed", DOMAIN, input.meter),
    rel(key("source_interpretation_domain", domain.id), DOMAIN, DOMAIN, input.meter),
    rel(key("semantic_correspondence_domain", input.query_semantics.evaluation!.domain), DOMAIN, DOMAIN, input.meter)];
}

function closureProof(input: Input, domain: SourceSemanticDomain): QueryProgram {
  if (domain.closure.kind !== "closed") return emptySemanticProgram;
  const evidence = "@finite:closure";
  const preserve = input.query_semantics.evaluation?.kind === "comparison" && input.query_semantics.evaluation.scope === "preserve";
  return sequence([rel(key("domain_closed"), DOMAIN, evidence, input.meter),
    semanticOwnerProof(input.source_interpretation, domain.closure.evidence, evidence, input.meter, preserve),
    rel(key("domain_closed_inv"), evidence, DOMAIN, input.meter)]);
}

function memberProof(input: Input, domain: SourceSemanticDomain, member: SourceSemanticDomain["members"][number],
  variable: string, suffix: string): QueryProgram {
  const evidence = `@member:${suffix}`;
  return sequence([rel(key("domain_member", member.referent), DOMAIN, variable, input.meter),
    rel(key("domain_member_evidence", domain.id), variable, evidence, input.meter),
    semanticOwnerProof(input.source_interpretation, member.evidence, evidence, input.meter, domain.context !== null),
    rel(key("domain_member_return", domain.id), evidence, DOMAIN, input.meter)]);
}

function compileUniversal(input: Input, domain: SourceSemanticDomain): SourceSemanticExecutionPlan {
  const { query_semantics: querySemantics, meter } = input, evaluation = querySemantics.evaluation!;
  if (evaluation.kind !== "forall") throw new TypeError("expected universal evaluation");
  if (domain.context !== null) return { program: emptySemanticProgram, branches: [], domain, missingOperands: false };
  const branches: SourceSemanticProofBranch[] = [], options: QueryProgram[] = [];
  const body = (member: SourceSemanticDomain["members"][number], memberIndex: number, counterexample: boolean) => {
    const finite = { source_interpretation: input.source_interpretation, population: input.population, semantic_correspondence: input.semantic_correspondence };
    const choices = querySemantics.alternatives.flatMap((alternative, index) => {
      if ((alternative.purpose === "counterexample") !== counterexample) return [];
      const frames = correspondenceGroupPhases(querySemantics, input.semantic_correspondence, index);
      return frames.map((group, groupIndex) => {
        meter.charge(1, 1024, "finite universal branch");
        const suffix = `:member${memberIndex}:alt${index}:g${groupIndex}`;
        const rename = (name: string) => evaluation.local_variables.includes(name) || name.startsWith("@") ? `${name}${suffix}` : name;
        const program = compileSourceSemanticAlternative(querySemantics, alternative, index, meter, finite, true, group);
        return sequence([memberProof(input, domain, member, rename(evaluation.binder), `${memberIndex}:${index}:${groupIndex}`),
          renameProgram(program, rename, meter),
          rel(key("domain_return", domain.id), rename(alternative.frames[0]!.variable), DOMAIN, meter)]);
      });
    });
    return alternatives(choices);
  };
  if (domain.closure.kind === "closed" && domain.context === null
    && (domain.members.length > 0 || querySemantics.return_variables.length === 0)) {
    const premises = domain.members.map((member, index) => body(member, index, false));
    const all: QueryProgram = premises.length === 0 ? { schema_version: 1, kind: "epsilon" }
      : { schema_version: 1, kind: "hyperedge", join: "and", premises };
    const index = branches.push({ purpose: "support", alternative: 0 }) - 1;
    options.push(sequence([...domainEntry(input, domain), closureProof(input, domain), all,
      rel(key("accept"), DOMAIN, `@accepted:${index}`, meter)]));
  }
  if (querySemantics.alternatives.some((row) => row.purpose === "counterexample")) for (const [memberIndex, member] of domain.members.entries()) {
    const index = branches.push({ purpose: "counterexample", alternative: 0, candidate: member.referent }) - 1;
    options.push(sequence([...domainEntry(input, domain), body(member, memberIndex, true),
      rel(key("accept"), DOMAIN, `@accepted:${index}`, meter)]));
  }
  return { program: alternatives(options), branches, domain, missingOperands: false };
}

function renameProgram(program: QueryProgram, rename: (id: string) => string, meter: SourceSemanticResourceLedger): QueryProgram {
  meter.charge(1, 256, "finite variable renaming");
  switch (program.kind) {
    case "relation": return { ...program, source_variable: rename(program.source_variable), target_variable: rename(program.target_variable) };
    case "sequence": return { ...program, steps: program.steps.map((row) => renameProgram(row, rename, meter)) };
    case "alternative": return { ...program, options: program.options.map((row) => renameProgram(row, rename, meter)) };
    case "hyperedge": return { ...program, premises: program.premises.map((row) => renameProgram(row, rename, meter)) };
    case "repeat": case "closure": return { ...program, local_variables: program.local_variables?.map(rename), body: renameProgram(program.body, rename, meter) };
    default: return program;
  }
}

function comparisonOrders(operation: string): readonly string[] {
  switch (operation) { case "lt": return ["lt"]; case "le": return ["lt", "eq"]; case "eq": return ["eq"];
    case "ge": return ["gt", "eq"]; case "gt": return ["gt"]; default: throw new TypeError("invalid comparator"); }
}

function numericProof(input: Input, domain: SourceSemanticDomain,
  leftVariable: string, rightVariable: string, orders: readonly string[], suffix: string,
  subjectCondition?: "allow_self" | "distinct"): QueryProgram {
  const evaluation = input.query_semantics.evaluation!;
  if (evaluation.kind !== "comparison") throw new TypeError("expected comparison");
  const pair = `@pair:${suffix}`, a = `@measure:${suffix}:left`, b = `@measure:${suffix}:right`;
  const leftOwner = `@owner:${suffix}:left`, rightOwner = `@owner:${suffix}:right`;
  const visit = (variable: string, owner: string, subject: string, side: string) => {
    const membership = `@membership:${suffix}:${side}`;
    const membershipProof = domain.context === null
      ? rel(key("source_interpretation_assertion_permission"), membership, membership, input.meter)
      : alternatives(domain.members.map((row) => semanticOwnerProof(input.source_interpretation, row.evidence, membership, input.meter, evaluation.scope === "preserve")));
    const memberships = [sequence([rel(key("measurement_membership"), variable, membership, input.meter), membershipProof,
      rel(key("measurement_membership_inv"), membership, variable, input.meter)])];
    if (input.semantic_correspondence.membership_assumptions?.some((row) => row.status === "member" && row.source_domain === domain.id
      && row.query_variable === subject)) memberships.push(sequence([
      rel(key("measurement_assumed_membership", subject), variable, subject, input.meter),
      rel(key("semantic_correspondence_referent", subject), subject, subject, input.meter),
      rel(key("measurement_assumed_membership_inv", subject), subject, variable, input.meter)]));
    const ownerPermission = evaluation.scope === "asserted"
      ? sequence([rel(key("measurement_owner"), variable, owner, input.meter),
        rel(key("source_interpretation_assertion_permission"), owner, owner, input.meter),
        rel(key("measurement_owner_inv"), owner, variable, input.meter)])
      : alternatives((input.source_interpretation.measurements ?? []).filter((row) => row.population === domain.id).map((measurement) => sequence([
        rel(key("source_interpretation_measurement", measurement.id), variable, variable, input.meter),
        rel(key("measurement_owner"), variable, owner, input.meter),
        semanticOwnerProof(input.source_interpretation, measurement.owner, owner, input.meter, true),
        rel(key("measurement_owner_inv"), owner, variable, input.meter)
      ])));
    const steps = [rel(key(`numeric_${side}`), pair, variable, input.meter),
      ownerPermission,
      alternatives(memberships),
      rel(key("measurement_subject"), variable, subject, input.meter)];
    if (input.query_semantics.variables.find((row) => row.id === subject)?.reference !== undefined) {
      steps.push(rel(key("semantic_correspondence_referent", subject), subject, subject, input.meter));
    }
    steps.push(rel(key("measurement_subject_inv"), subject, variable, input.meter),
      rel(key(`numeric_${side}_inv`), variable, pair, input.meter));
    return sequence(steps);
  };
  const orderProofs = orders.map((order) => rel(key("numeric_order", order), pair, pair, input.meter));
  if (subjectCondition === "allow_self") orderProofs.push(sequence([
    rel(key("numeric_same_subject"), pair, pair, input.meter), rel(key("numeric_order", "eq"), pair, pair, input.meter)]));
  return sequence([rel(key("candidate_route"), DOMAIN, pair, input.meter),
    ...(subjectCondition === "distinct" ? [rel(key("numeric_distinct_subject"), pair, pair, input.meter)] : []),
    alternatives(orderProofs),
    visit(a, leftOwner, leftVariable, "left"), visit(b, rightOwner, rightVariable, "right"),
    rel(key("domain_return", domain.id), pair, DOMAIN, input.meter)]);
}

function compileComparison(input: Input, domain: SourceSemanticDomain): SourceSemanticExecutionPlan {
  const evaluation = input.query_semantics.evaluation!;
  if (evaluation.kind !== "comparison") throw new TypeError("expected comparison evaluation");
  const values = (input.source_interpretation.measurements ?? []).filter((row) => row.population === domain.id);
  const branches: SourceSemanticProofBranch[] = [], options: QueryProgram[] = [];
  const add = (purpose: SourceSemanticProofBranch["purpose"], body: QueryProgram, candidate?: string, closed = false) => {
    const index = branches.push({ purpose, alternative: 0, ...(candidate === undefined ? {} : { candidate }) }) - 1;
    options.push(sequence([...domainEntry(input, domain), ...(closed ? [closureProof(input, domain)] : []), body,
      rel(key("accept"), DOMAIN, `@accepted:${index}`, input.meter)]));
  };
  const extreme = evaluation.operation === "minimum" || evaluation.operation === "maximum";
  if (extreme && domain.members.length === 0 && domain.closure.kind === "closed") {
    add("empty_domain", { schema_version: 1, kind: "epsilon" }, undefined, true);
  }
  if (!extreme) {
    const orders = comparisonOrders(evaluation.operation), inverse = ["lt", "eq", "gt"].filter((order) => !orders.includes(order));
    add("support", numericProof(input, domain, evaluation.left, evaluation.right!, orders, "yes"));
    add("counterexample", numericProof(input, domain, evaluation.left, evaluation.right!, inverse, "no"));
    add("incomparable", numericProof(input, domain, evaluation.left, evaluation.right!, ["incomparable"], "inc"));
  } else {
    const anyMember = (variable: string, suffix: string) => alternatives(domain.members.map((member, index) =>
      memberProof(input, domain, member, variable, `${suffix}:${index}`)));
    const operation = evaluation.operation === "minimum" ? evaluation.strict ? "lt" : "le" : evaluation.strict ? "gt" : "ge";
    const positive = comparisonOrders(operation);
    const pairs = domain.members.map((competitor, index) => sequence([
      memberProof(input, domain, competitor, `@competitor:${index}`, `competitor:${index}`),
      numericProof(input, domain, evaluation.left, `@competitor:${index}`, positive, `all:${index}`,
        evaluation.strict ? "allow_self" : undefined)
    ]));
    if (domain.closure.kind === "closed" && pairs.length > 0) add("support", sequence([
      { schema_version: 1, kind: "hyperedge", join: "and", premises: pairs }, anyMember(evaluation.left, "candidate")
    ]), undefined, true);
    for (const purpose of ["counterexample", "incomparable"] as const) {
      add(purpose, sequence([
        numericProof(input, domain, evaluation.left, "@competitor", purpose === "incomparable" ? ["incomparable"]
          : ["lt", "eq", "gt"].filter((order) => !positive.includes(order)), purpose,
        purpose === "counterexample" ? "distinct" : undefined),
        anyMember(evaluation.left, "candidate"), anyMember("@competitor", "other")
      ]));
      branches[branches.length - 1] = { ...branches.at(-1)!, candidate_variable: evaluation.left };
    }
  }
  const referenced = (id: string | undefined) => input.semantic_correspondence.correspondences.find((row) => row.query_endpoint.kind === "referent"
    && row.query_endpoint.variable === id)?.source_endpoint;
  const operands = [referenced(evaluation.left), referenced(evaluation.right)].flatMap((row) => row?.kind === "referent" ? [row.referent] : []);
  const missingOperands = extreme ? domain.members.some((row) => !values.some((value) => value.subject === row.referent))
    : operands.some((id) => !values.some((value) => value.subject === id)) || values.length === 0;
  const missingMembership = !extreme && operands.some((id) => !domain.members.some((row) => row.referent === id));
  return { program: alternatives(options), branches, domain, missingOperands, missingMembership };
}
