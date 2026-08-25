import { describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { RecallQueryDemand } from "../../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import { shadowLineageApplicability } from "../../../recall/shadow/index.js";

function demand(kinds: RecallQueryDemand["atoms"][number]["kind"][]): RecallQueryDemand {
  return {
    schema_version: 1,
    atoms: kinds.map((kind) => ({
      id: `${kind}:x`,
      kind,
      value: "x",
      priority: "supporting"
    }))
  };
}

describe("shadow demand applicability aliases", () => {
  it("reads RecallQueryDemand and probes instead of forking a second demand type", () => {
    const lexical = shadowLineageApplicability({
      demand: demand(["lexical_term"]),
      probes: compileRecallQueryProbes("find the notes"),
      arm: "E0"
    });
    expect(lexical.lexical).toBe(true);
    expect(lexical.embedding).toBe(false);
    expect(lexical.temporal).toBe(false);

    const e1 = shadowLineageApplicability({
      demand: demand([]),
      probes: compileRecallQueryProbes(null),
      arm: "E1"
    });
    expect(e1.embedding).toBe(true);
    expect(e1.lexical).toBe(false);
  });

  it("keeps subject applicable when preference projection is off but self-reference is on", () => {
    const probes = {
      ...compileRecallQueryProbes("what did I say"),
      dimensions: [],
      subject_hints: ["self_reference"] as const
    };
    const applicability = shadowLineageApplicability({
      demand: demand(["lexical_term"]),
      probes,
      arm: "E0"
    });
    expect(probes.dimensions).not.toContain(MemoryDimension.PREFERENCE);
    expect(applicability.subject_preference).toBe(true);
  });
});
