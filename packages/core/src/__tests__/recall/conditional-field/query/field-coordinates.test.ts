import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type Guard,
  type QueryHypothesis,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import {
  collectRecoverableBindings,
  collectRelations,
  compileConditionalFieldQuery,
  recoverableBindingContext,
  SERVICE_VARIABLE,
  sourceBoundEntityGuard,
  UNBOUND_BINDING_CONTEXT,
  USES_SERVICE_RELATION
} from "../../../../recall/conditional-field/query/compile-query.js";
import {
  completenessForInterpretationStatus,
  interpretationCoverageFor
} from "../../../../recall/conditional-field/reference/interpret-query.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget
} from "../reference/deployment.fixture.js";

describe("conditional-field query field coordinates", () => {
  it("A02 keeps same-service history as association without a causal predicate", () => {
    const interpretation = compileOrdinary(
      "prior same-service failure around yesterday's failed deployment"
    );
    const relations = collectRelations(interpretation.program);
    expect(relations.some((relation) => (
      relation.relation_kind === USES_SERVICE_RELATION
      && relation.target_variable === SERVICE_VARIABLE
    ))).toBe(true);
    expect(relations.some((relation) => (
      relation.relation_kind === "associated_history"
      && relation.source_variable === SERVICE_VARIABLE
    ))).toBe(true);
    expect(relations.every((relation) => (
      relation.relation_kind !== "caused_by"
      && relation.relation_kind !== "common_cause"
    ))).toBe(true);
    expect(interpretation.status).toBe("partial");
  });

  it("B04 same-service binding is not a shared-provider object", () => {
    const serviceA = compileTyped(usesServiceProgram("service-a"));
    const serviceB = compileTyped(usesServiceProgram("service-b"));
    const provider = compileTyped(usesServiceProgram("shared-provider"));
    expect(collectRecoverableBindings(serviceA.program)).toEqual([
      binding(SERVICE_VARIABLE, "service-a")
    ]);
    expect(recoverableBindingContext(collectRecoverableBindings(serviceA.program)))
      .toBe(`${SERVICE_VARIABLE}=service-a`);
    expect(recoverableBindingContext(collectRecoverableBindings(serviceA.program)))
      .not.toMatch(/^sha256:/u);
    expect(serviceA.query_id).not.toBe(serviceB.query_id);
    expect(serviceA.query_id).not.toBe(provider.query_id);
    expect(serviceA.program).not.toEqual(provider.program);
    const plantedBridge = collectRecoverableBindings(provider.program)[0]?.value;
    expect(plantedBridge).toBe("shared-provider");
    expect(collectRecoverableBindings(serviceA.program)[0]?.value).not.toBe(plantedBridge);
    const ordinary = compileOrdinary("yesterday's failed deployment");
    expect(collectRelations(ordinary.program).some((relation) => (
      relation.relation_kind === USES_SERVICE_RELATION
      && relation.target_variable === SERVICE_VARIABLE
      && relation.guard.kind === "interval_relation"
    ))).toBe(true);
    expect(collectRecoverableBindings(ordinary.program)).toEqual([]);
    expect(recoverableBindingContext([])).toBe(UNBOUND_BINDING_CONTEXT);
    const lexical = compileOrdinary("deployment rules");
    expect(collectRelations(lexical.program).some((relation) => (
      relation.relation_kind === USES_SERVICE_RELATION
    ))).toBe(false);
  });

  it("B01 keeps recoverable bindings as distinct product coordinates", () => {
    const left = compileTyped(usesServiceProgram("service-a"));
    const right = compileTyped(usesServiceProgram("service-b"));
    expect(left.query_id).not.toBe(right.query_id);
    expect(recoverableBindingContext(collectRecoverableBindings(left.program)))
      .not.toBe(recoverableBindingContext(collectRecoverableBindings(right.program)));
    const hashedMerge = "sha256:" + "a".repeat(64);
    expect(recoverableBindingContext(collectRecoverableBindings(left.program)))
      .not.toBe(hashedMerge);
  });

  it("B05 does not mark omitted hypotheses as resolved coverage", () => {
    const first = hypothesis("h-failed-deployment", "event", "failed_deployment");
    const second = hypothesis("h-unresolved-event", "event", "unresolved");
    const compiled = compileConditionalFieldQuery({
      source: "typed",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      program: usesServiceProgram("service-a"),
      hypotheses: [first, second],
      interpretation_clock: INTERPRETATION_CLOCK
    });
    expect(compiled.status).toBe("hypotheses");
    expect(compiled.status).not.toBe("resolved");
    expect(compiled.hypotheses).toHaveLength(2);
    expect(interpretationCoverageFor(compiled.status, compiled)).toBe("open");
    expect(interpretationCoverageFor(compiled.status, compiled)).not.toBe("complete");
    expect(completenessForInterpretationStatus(compiled.status)).toBeUndefined();
    const plantedCertainty = interpretationCoverageFor("resolved");
    expect(plantedCertainty).not.toBe(interpretationCoverageFor(compiled.status, compiled));
    const ambiguous = compileOrdinary("yesterday's failure");
    expect(ambiguous.status).toBe("hypotheses");
    expect(interpretationCoverageFor(ambiguous.status, ambiguous)).toBe("open");
  });

  it("A04 keeps association finite and explicit rather than an unbounded spread", () => {
    const supported = compileOrdinary("yesterday's failed deployment");
    expect(collectRelations(supported.program)).toHaveLength(5);
    const repeat = compileTyped({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "repeat",
      count: 8,
      body: usesServiceProgram("service-a")
    });
    expect(repeat.status).toBe("resolved");
    expect(repeat.program.kind).toBe("repeat");
    const overflow = compileTyped({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "repeat",
      count: 9,
      body: usesServiceProgram("service-a")
    });
    expect(overflow.status).toBe("malformed");
  });

  it("A07 retains hyperedge AND versus alternative OR as distinct bindings", () => {
    const left = relation("p1", "a", "b");
    const right = relation("p2", "b", "c", sourceBoundEntityGuard("c", "cfg-1"));
    const andJoin = compileTyped({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "hyperedge",
      join: "and",
      premises: [left, right]
    });
    const orJoin = compileTyped({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "hyperedge",
      join: "or",
      premises: [left, right]
    });
    expect(andJoin.status).toBe("resolved");
    expect(orJoin.status).toBe("resolved");
    expect(andJoin.program).not.toEqual(orJoin.program);
    expect(andJoin.program.kind === "hyperedge" ? andJoin.program.join : undefined).toBe("and");
    expect(orJoin.program.kind === "hyperedge" ? orJoin.program.join : undefined).toBe("or");
    expect(collectRecoverableBindings(andJoin.program)).toEqual([binding("c", "cfg-1")]);
    const plantedCollapse = andJoin.program.kind === "hyperedge"
      ? { ...andJoin.program, join: "or" as const }
      : andJoin.program;
    expect(plantedCollapse).not.toEqual(andJoin.program);
    const nested = compileTyped({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "sequence",
      steps: [left, {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "hyperedge",
        join: "and",
        premises: [left, right]
      }]
    });
    expect(nested.status).toBe("resolved");
    expect(nested.program.kind).toBe("sequence");
    expect(collectRecoverableBindings(nested.program)).toEqual([binding("c", "cfg-1")]);
  });

  it("keeps unresolved holes open when an optional source is absent", () => {
    const partial = compileOrdinary("failed deployment of checkout");
    expect(partial.status).toBe("partial");
    expect(partial.holes.some((hole) => hole.status === "open")).toBe(true);
    expect(interpretationCoverageFor(partial.status, partial)).toBe("open");
    expect(interpretationCoverageFor(partial.status, partial)).not.toBe("complete");
    const reads: string[] = [];
    compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "failed deployment of checkout",
      interpretation_clock: INTERPRETATION_CLOCK,
      memory: {
        readAuthorizedSnapshot(input) {
          reads.push(input.snapshot_id);
        }
      }
    });
    expect(reads).toEqual([]);
  });
});

function compileOrdinary(text: string) {
  return compileConditionalFieldQuery({
    source: "ordinary",
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    text,
    interpretation_clock: INTERPRETATION_CLOCK
  });
}

function compileTyped(program: QueryProgram) {
  return compileConditionalFieldQuery({
    source: "typed",
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    program,
    interpretation_clock: INTERPRETATION_CLOCK
  });
}

function usesServiceProgram(entityId: string): QueryProgram {
  return relation(
    USES_SERVICE_RELATION,
    "r",
    SERVICE_VARIABLE,
    sourceBoundEntityGuard(SERVICE_VARIABLE, entityId)
  );
}

function relation(
  relationKind: string,
  source: string,
  target: string,
  guard: Guard = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "query_predicate",
    verdict: "unresolved",
    variable: target,
    time_scope: "none"
  }
): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: source,
    target_variable: target,
    guard,
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

function hypothesis(id: string, variable: string, value: string): QueryHypothesis {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hypothesis_id: id,
    bindings: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      variable,
      value
    }]
  };
}

function binding(variable: string, value: string) {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    variable,
    value
  };
}
