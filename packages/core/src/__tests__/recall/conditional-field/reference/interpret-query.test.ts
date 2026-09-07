import { describe, expect, it } from "vitest";
import {
  completenessForInterpretationStatus,
  interpretationCoverageFor,
  interpretQuery
} from "../../../../recall/conditional-field/reference/interpret-query.js";
import type { QueryHypothesis, QueryProgram } from "@do-soul/alaya-protocol";

const epsilon: QueryProgram = { schema_version: 1, kind: "epsilon" };
const empty: QueryProgram = { schema_version: 1, kind: "empty" };
const relation: QueryProgram = {
  schema_version: 1,
  kind: "relation",
  relation_kind: "associated_config",
  source_variable: "r",
  target_variable: "c",
  guard: {
    schema_version: 1,
    kind: "equality",
    verdict: "unresolved",
    variable: "c",
    time_scope: "none"
  },
  facet_mode: "same_path",
  threshold_milligrades: 0
};

describe("conditional-field reference program interpreter", () => {
  it("treats epsilon as the serial identity and empty as the sequence annihilator", () => {
    expect(interpretQuery({ schema_version: 1, kind: "sequence", steps: [epsilon, relation] }))
      .toEqual({ kind: "program", program: relation });
    expect(interpretQuery({ schema_version: 1, kind: "sequence", steps: [relation, epsilon] }))
      .toEqual({ kind: "program", program: relation });
    expect(interpretQuery({ schema_version: 1, kind: "sequence", steps: [empty, relation] }))
      .toEqual({ kind: "empty" });
    expect(interpretQuery({ schema_version: 1, kind: "sequence", steps: [relation, empty] }))
      .toEqual({ kind: "empty" });
    expect(interpretQuery({ schema_version: 1, kind: "sequence", steps: [epsilon, empty] }))
      .toEqual({ kind: "empty" });
  });

  it("treats empty as the alternative identity and keeps epsilon distinct", () => {
    expect(interpretQuery({ schema_version: 1, kind: "alternative", options: [empty, relation] }))
      .toEqual({ kind: "program", program: relation });
    expect(interpretQuery({ schema_version: 1, kind: "alternative", options: [relation, empty] }))
      .toEqual({ kind: "program", program: relation });
    expect(interpretQuery({ schema_version: 1, kind: "alternative", options: [epsilon, empty] }))
      .toEqual({ kind: "epsilon" });
    expect(interpretQuery(epsilon).kind).toBe("epsilon");
    expect(interpretQuery(empty).kind).toBe("empty");
  });

  it("unfolds repeat as a sequence of the body", () => {
    const unfolded = interpretQuery({
      schema_version: 1,
      kind: "repeat",
      count: 2,
      body: relation
    });
    expect(unfolded).toEqual({
      kind: "program",
      program: { schema_version: 1, kind: "sequence", steps: [relation, relation] }
    });
    expect(interpretQuery({ schema_version: 1, kind: "repeat", count: 1, body: epsilon }))
      .toEqual({ kind: "epsilon" });
  });

  it("keeps closure as open work unless the product key is marked sufficient", () => {
    const closure: QueryProgram = {
      schema_version: 1,
      kind: "closure",
      product_state_sufficient: true,
      body: relation
    };
    expect(interpretQuery(closure)).toEqual({ kind: "program", program: closure });
    expect(interpretQuery(closure, { productKeySufficient: true }))
      .toEqual({ kind: "program", program: relation });
  });

  it("A04 refuses unbounded repeat instead of compiling a hidden flood", () => {
    expect(interpretQuery({
      schema_version: 1,
      kind: "repeat",
      count: 9,
      body: relation
    }).kind).toBe("unsupported");
    expect(interpretQuery({
      schema_version: 1,
      kind: "repeat",
      count: 0,
      body: relation
    }).kind).toBe("unsupported");
  });

  it("A07 keeps hyperedge AND distinct from alternative OR and from a planted join rewrite", () => {
    const andJoin: QueryProgram = {
      schema_version: 1,
      kind: "hyperedge",
      join: "and",
      premises: [relation, relation]
    };
    const orJoin: QueryProgram = {
      schema_version: 1,
      kind: "hyperedge",
      join: "or",
      premises: [relation, relation]
    };
    expect(interpretQuery(andJoin)).toEqual({ kind: "program", program: andJoin });
    expect(interpretQuery(orJoin)).toEqual({ kind: "program", program: orJoin });
    expect(interpretQuery(andJoin)).not.toEqual(interpretQuery(orJoin));
    const nested: QueryProgram = {
      schema_version: 1,
      kind: "sequence",
      steps: [relation, andJoin]
    };
    expect(interpretQuery(nested)).toEqual({
      kind: "program",
      program: { schema_version: 1, kind: "sequence", steps: [relation, andJoin] }
    });
    const plantedOr: QueryProgram = { ...andJoin, join: "or" };
    expect(interpretQuery(plantedOr)).not.toEqual(interpretQuery(andJoin));
  });

  it("B05 keeps hypothesis coverage open and does not treat it as envelope rejection", () => {
    const hypotheses: readonly QueryHypothesis[] = [{
      schema_version: 1,
      hypothesis_id: "h1",
      bindings: [{ schema_version: 1, variable: "event", value: "failed_deployment" }]
    }, {
      schema_version: 1,
      hypothesis_id: "h2",
      bindings: [{ schema_version: 1, variable: "event", value: "unresolved" }]
    }];
    expect(interpretationCoverageFor("hypotheses", { hypotheses })).toBe("open");
    expect(interpretationCoverageFor("hypotheses", { hypotheses })).not.toBe("complete");
    expect(completenessForInterpretationStatus("hypotheses")).toBeUndefined();
    expect(completenessForInterpretationStatus("partial")).toBeUndefined();
    expect(completenessForInterpretationStatus("unsupported")?.interpretation_coverage)
      .toBe("unavailable");
    expect(completenessForInterpretationStatus("resource_rejected")?.interpretation_coverage)
      .toBe("resource_rejected");
    expect(interpretationCoverageFor("resolved")).toBe("complete");
    const plantedComplete = interpretationCoverageFor("resolved");
    expect(plantedComplete).not.toBe(interpretationCoverageFor("hypotheses", { hypotheses }));
  });
});
