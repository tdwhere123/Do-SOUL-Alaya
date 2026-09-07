import { describe, expect, it } from "vitest";
import {
  CompletenessReportSchema,
  DerivationSchema,
  IndexEntrySchema,
  QueryProgramSchema,
  UsageReportSchema,
  type Derivation,
  type IndexEntry
} from "../../../recall/conditional-field/index.js";

const SNAPSHOT = `sha256:${"b".repeat(64)}`;

function acceptingKey(entry: IndexEntry): string {
  return [
    entry.object_id,
    entry.hypothesis_id,
    entry.output_binding,
    entry.program_state ?? "",
    entry.time_state ?? ""
  ].join("\0");
}

function leaf(id: string): Derivation {
  return DerivationSchema.parse({
    schema_version: 1,
    derivation_id: id,
    kind: "leaf",
    children: [],
    observation_ids: [id],
    leaf_ids: [id],
    source_revisions: [`src-${id}`]
  });
}

function node(
  id: string,
  kind: "serial" | "and" | "or",
  children: readonly Derivation[]
): Derivation {
  return DerivationSchema.parse({
    schema_version: 1,
    derivation_id: id,
    kind,
    children: children.map((child) => child.derivation_id),
    observation_ids: children.flatMap((child) => child.observation_ids),
    leaf_ids: children.flatMap((child) => child.leaf_ids),
    source_revisions: children.flatMap((child) => child.source_revisions)
  });
}

function withdrawLeaf(
  forest: ReadonlyMap<string, Derivation>,
  rootId: string,
  withdrawn: string
): Derivation | undefined {
  const current = forest.get(rootId);
  if (current === undefined) return undefined;
  if (current.kind === "leaf") {
    return current.derivation_id === withdrawn ? undefined : current;
  }
  const kept: Derivation[] = [];
  for (const childId of current.children) {
    const next = withdrawLeaf(forest, childId, withdrawn);
    if (next !== undefined) kept.push(next);
  }
  if (current.kind === "and" && kept.length !== current.children.length) return undefined;
  if (kept.length === 0) return undefined;
  if (kept.length === 1 && current.kind === "or") return kept[0];
  return node(`${current.derivation_id}-w`, current.kind, kept);
}

function relationProgram(serviceId: string) {
  return QueryProgramSchema.parse({
    schema_version: 1,
    kind: "relation",
    relation_kind: "uses_service",
    source_variable: "deployment",
    target_variable: "service",
    guard: {
      schema_version: 1,
      kind: "source_bound_entity",
      verdict: "unresolved",
      variable: "service",
      entity_id: serviceId
    }
  });
}

function indexEntry(input: {
  readonly object_id: string;
  readonly program_state?: string;
  readonly time_state?: string;
}): IndexEntry {
  return IndexEntrySchema.parse({
    schema_version: 1,
    object_id: input.object_id,
    hypothesis_id: "h0",
    output_binding: "requested",
    role: "requested",
    association_milligrades: 850,
    claim: "unknown",
    explanation_ids: [],
    ...(input.program_state === undefined ? {} : { program_state: input.program_state }),
    ...(input.time_state === undefined ? {} : { time_state: input.time_state })
  });
}

describe("U00 upgrade contracts", () => {
  it("B01 keeps object+program+time as distinct accepting keys", () => {
    const left = indexEntry({ object_id: "cfg", program_state: "accepting", time_state: "yesterday" });
    const right = indexEntry({ object_id: "cfg", program_state: "mid", time_state: "yesterday" });
    expect(acceptingKey(left)).not.toBe(acceptingKey(right));
    const plantedMerge = acceptingKey(indexEntry({ object_id: "cfg" }));
    expect(plantedMerge).not.toBe(acceptingKey(left));
  });

  it("B03 equal-leaf AND/OR structures remain distinct after withdrawing c", () => {
    const a = leaf("a");
    const b = leaf("b");
    const c = leaf("c");
    const andAb = node("and-ab", "and", [a, b]);
    const orAbc = node("or-left", "or", [andAb, c]);
    const orAb = node("or-ab", "or", [a, b]);
    const andAbc = node("and-right", "and", [orAb, c]);
    const forest = new Map<string, Derivation>([
      [a.derivation_id, a],
      [b.derivation_id, b],
      [c.derivation_id, c],
      [andAb.derivation_id, andAb],
      [orAbc.derivation_id, orAbc],
      [orAb.derivation_id, orAb],
      [andAbc.derivation_id, andAbc]
    ]);
    expect(new Set(orAbc.leaf_ids)).toEqual(new Set(andAbc.leaf_ids));
    const afterOr = withdrawLeaf(forest, orAbc.derivation_id, "c");
    const afterAnd = withdrawLeaf(forest, andAbc.derivation_id, "c");
    expect(afterOr?.kind).toBe("and");
    expect(afterOr?.leaf_ids).toEqual(["a", "b"]);
    expect(afterAnd).toBeUndefined();
    const plantedCollapse = afterOr?.kind === afterAnd?.kind;
    expect(plantedCollapse).toBe(false);
  });

  it("B04 same-service binding is not a shared-provider object", () => {
    const serviceA = relationProgram("service-a");
    const serviceB = relationProgram("service-b");
    expect(serviceA).not.toEqual(serviceB);
    expect(serviceA.kind === "relation" && serviceA.guard.entity_id).toBe("service-a");
    const plantedBridge = relationProgram("shared-provider");
    expect(plantedBridge).not.toEqual(serviceA);
  });

  it("B05 interpretation coverage is independent of observer coverage", () => {
    const observedComplete = CompletenessReportSchema.parse({
      schema_version: 1,
      logical_index: "complete",
      observed_coverage: "complete",
      interpretation_coverage: "open",
      transport: "complete",
      payload: "omitted",
      representation: "complete"
    });
    expect(observedComplete.observed_coverage).toBe("complete");
    expect(observedComplete.interpretation_coverage).toBe("open");
    const plantedCertainty = CompletenessReportSchema.parse({
      ...observedComplete,
      interpretation_coverage: "complete"
    });
    expect(plantedCertainty.interpretation_coverage).not.toBe(observedComplete.interpretation_coverage);
  });

  it("B10 output grain cannot stand in for a witness report", () => {
    const outputOnly = UsageReportSchema.parse({
      schema_version: 1,
      grain: "output",
      exposure: "exposed",
      reported_use: "used",
      output_id: "idx-1",
      query_id: "q1",
      snapshot_id: SNAPSHOT
    });
    expect(outputOnly.grain).toBe("output");
    expect(outputOnly.witness_id).toBeUndefined();
    const witness = UsageReportSchema.parse({
      schema_version: 1,
      grain: "witness",
      exposure: "exposed",
      reported_use: "used",
      witness_id: "w1",
      object_id: "cfg",
      query_id: "q1",
      snapshot_id: SNAPSHOT
    });
    expect(witness.grain).toBe("witness");
    expect(witness.witness_id).toBe("w1");
    expect(() => UsageReportSchema.parse({
      schema_version: 1,
      grain: "witness",
      exposure: "exposed",
      reported_use: "used",
      output_id: "idx-1"
    })).toThrow();
  });
});
