import { describe, expect, it } from "vitest";
import { interpretQuery } from "../../../../recall/conditional-field/reference/interpret-query.js";
import type { QueryProgram } from "@do-soul/alaya-protocol";

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
});
