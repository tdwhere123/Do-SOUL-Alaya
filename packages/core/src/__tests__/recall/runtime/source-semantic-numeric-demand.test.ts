import { expect, it } from "vitest";
import { sourceSemanticCorrespondenceIdentity, sourceSemanticInterpretationIdentity,
  sourceSemanticQueryIdentity, SourceSemanticInterpretationSchema,
  type SourceSemanticInterpretation, type SourceSemanticQuery, type RequestBudget } from "@do-soul/alaya-protocol";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";
import { finiteSource, finiteQuery, finiteCorrespondence, FINITE_QUERY } from "./source-semantic-finite-fixture.js";
import { executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET } from "../../../recall/runtime/source-semantic-reasoning.js";
import { CLOCK } from "./source-semantic-proof-fixture.js";
import { compileSourceSemanticPremises, sourceSemanticReaders, sourceSemanticRelationKey } from "../../../recall/runtime/source-semantic-premises.js";
import { SourceSemanticResourceLedger, interpretationNodeIdentity } from "@do-soul/alaya-protocol";

function measuredSource(count: number): SourceSemanticInterpretation {
  const base = finiteSource();
  // A distinct already-declared referent is in the same closed population, but
  // none of its measurements can bind either named operand of the query.
  const source = { ...base,
    domains: base.domains!.map(domain => ({ ...domain,
      members: [...domain.members, { referent: "rX", evidence: "fMemberAlice", restrictions: [] }] })),
    measurements: [...base.measurements!, ...Array.from({ length: count }, (_, index) => ({
      ...base.measurements![0]!, id: `unrelated${index}`, subject: "rX", metric: `unrelated${index}`
    }))] };
  return SourceSemanticInterpretationSchema.parse(source);
}

function comparison(operation: "eq" | "lt" | "le" | "gt" | "ge", left = "actor", right = "tools"): SourceSemanticQuery {
  const base = finiteQuery(true);
  const common = { kind: "comparison" as const, domain: "people", left, right,
    metric: "speed", unit: "ms", context: "lab", scope: "asserted" as const };
  return { ...base,
    variables: [{ id: "actor", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } },
      { id: "tools", sort: "entity", reference: { kind: "query_text", excerpt: "Bob" } }],
    alternatives: [{ frames: [], context_obligations: [] }], return_variables: ["actor", "tools"],
    evaluation: operation === "lt" || operation === "gt"
      ? { ...common, operation, strict: true } : { ...common, operation, strict: false } };
}

function execute(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, budget?: RequestBudget,
  actorReferents?: readonly string[], rightReferent = "rBob") {
  const sourceCorrespondence = finiteCorrespondence(interpretation, semantics);
  const correspondence = semantics.evaluation?.kind !== "comparison" ? sourceCorrespondence
    : !("right" in semantics.evaluation) ? { ...sourceCorrespondence, correspondences: [] } : { ...sourceCorrespondence, correspondences: [
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "referent" as const, variable: "actor" },
      source_endpoint: { kind: "referent" as const, referent: "rAlice" },
      query_support: { kind: "query_text" as const, excerpt: "Alice" }, source_semantic_support: [{ kind: "lexical" as const, mentions: ["mAlice"] }] },
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "referent" as const, variable: "tools" },
      source_endpoint: { kind: "referent" as const, referent: "rBob" },
      query_support: { kind: "query_text" as const, excerpt: "Bob" }, source_semantic_support: [{ kind: "lexical" as const, mentions: ["mBob"] }] },
  ] };
  const aligned = actorReferents === undefined ? correspondence : { ...correspondence, correspondences: [
    ...actorReferents.map(referent => ({ ...correspondence.correspondences[0]!,
      source_endpoint: { kind: "referent" as const, referent },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [`m${referent.slice(1)}`] }] })),
    { ...correspondence.correspondences[1]!, source_endpoint: { kind: "referent" as const, referent: rightReferent },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [`m${rightReferent.slice(1)}`] }] }
  ] };
  const result = executeSourceSemanticInterpretation({ source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: aligned, original_query: FINITE_QUERY, workspaceId: "ws", scope: "project",
    authorizedScopes: ["project"], asOf: CLOCK,
    ...(budget === undefined ? {} : { request: { contract: "source-interpretation-reasoning-v5",
      accepts_unreviewed_conditional_results: true, source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, sha),
      query_semantics_id: sourceSemanticQueryIdentity(semantics, sha),
      semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(aligned, sha), original_query: FINITE_QUERY,
      budget, output_byte_limit: 1000000 } }) });
  return { result, correspondence: aligned };
}

it("reaches native reasoning and delivery with over forty unused measurements on the default budget", () => {
  const source = measuredSource(46), ordinary = finiteQuery();
  const { result } = execute(source, ordinary);
  expect(result.result.outcome.status, JSON.stringify(result.result.outcome)).toBe("interpreted");
  expect(result.result.binding_results?.map(row => row.returned.actor?.node_id).sort()).toEqual(["rAlice", "rBob", "rX"]);
  expect(result.index?.entries.length).toBeGreaterThan(0);
  expect(result.result.resource_usage!.memory_bytes).toBeLessThan(SOURCE_SEMANTIC_REASONING_BUDGET.memory_bytes);
  expect(result.result.consumed_leaves.some(row => row.leaf_kind === "source_interpretation_numeric_order")).toBe(false);
});

it("constructs only demanded named-operand pairs and keeps real relation-reader accounting", () => {
  const source = measuredSource(46), semantics = comparison("eq");
  const { result, correspondence } = execute(source, semantics);
  expect(result.result.outcome.status, JSON.stringify(result.result.outcome)).toBe("interpreted");
  expect(result.result.evaluation?.status).toBe("supported");
  expect(result.result.consumed_leaves).toEqual(expect.arrayContaining([
    expect.objectContaining({ leaf_kind: "source_interpretation_numeric_order", measurement: "valueAlice", other_measurement: "valueBob", value: "eq" })
  ]));
  const meter = new SourceSemanticResourceLedger(SOURCE_SEMANTIC_REASONING_BUDGET);
  const population = compileSourceSemanticPremises({ interpretation: source, query: semantics, semantic_correspondence: correspondence,
    context_id: "demand-test", interpretation_id: sourceSemanticInterpretationIdentity(source, sha), scope: "project",
    source_target: { kind: "source_evidence", workspace_id: "ws", root_kind: "source_record", root_id: source.source.source_id,
      source_version: source.source.source_version, content_digest: source.source.content_digest, evidence_object_id: null }, meter });
  const pairs = population.derivedNodes.filter(row => row.kind === "comparison");
  expect(pairs).toHaveLength(1);
  const id = interpretationNodeIdentity(population.coordinates.get(pairs[0]!.node_id)!);
  const page = sourceSemanticReaders(population, []).relation!({ workspaceId: "ws", subject: id, predicate: sourceSemanticRelationKey("numeric_order", "eq"),
    limit: 10, nativeLimit: 10, afterAssertionId: null, byteLimit: 100000 });
  expect(page.observations).toHaveLength(1);
  expect(page.rowsRead).toBe(1);
  expect(page.bytesRead).toBeGreaterThan(0);
  expect(page.bytesRead).toBe(Buffer.byteLength(JSON.stringify(page.observations[0])));
  expect(page.nativeBytes).toBe(page.bytesRead);
  expect(meter.spentBytes).toBeLessThan(SOURCE_SEMANTIC_REASONING_BUDGET.memory_bytes);
});

it("admits every named referent alignment and delivers the only measured operand regardless of correspondence order", () => {
  const source = finiteSource(), semantics = comparison("eq");
  for (const alignments of [["rX", "rBob"], ["rBob", "rX"]]) {
    const { result, correspondence } = execute(source, semantics, undefined, alignments, "rAlice");
    expect(correspondence.correspondences).toHaveLength(3);
    expect(result.result.outcome.status, JSON.stringify(result.result.outcome)).toBe("interpreted");
    expect(result.result.evaluation?.status).toBe("supported");
    expect(result.result.binding_results?.map(row => [row.returned.actor?.node_id, row.returned.tools?.node_id]))
      .toContainEqual(["rBob", "rAlice"]);
    expect(result.result.consumed_leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ leaf_kind: "semantic_correspondence_referent", occurrence: "rBob" }),
      expect.objectContaining({ leaf_kind: "source_interpretation_numeric_order",
        measurement: "valueBob", other_measurement: "valueAlice", value: "eq" })
    ]));
    expect(result.index?.entries.length).toBeGreaterThan(0);
  }
});

it("retains the second aligned subject's counterexample and incomparable signature in delivered evidence", () => {
  const base = measuredSource(0), semantics = comparison("eq");
  const source = SourceSemanticInterpretationSchema.parse({ ...base,
    measurements: [...base.measurements!, { ...base.measurements![0]!, id: "valueX", subject: "rX" }] });
  for (const [change, order] of [[{ value: "3" }, "gt"], [{ unit: "kg" }, "incomparable"]] as const) {
    const changed = SourceSemanticInterpretationSchema.parse({ ...source,
      measurements: source.measurements!.map(row => row.id === "valueBob" ? { ...row, ...change } : row) });
    for (const alignments of [["rAlice", "rBob"], ["rBob", "rAlice"]]) {
      const { result } = execute(changed, semantics, undefined, alignments, "rX");
      expect(result.result.outcome.status, JSON.stringify(result.result.outcome)).toBe("interpreted");
      expect(result.result.evaluation?.status).toBe(order === "gt" ? "inconsistent" : "supported");
      if (order === "gt") expect(result.result.evaluation?.counterexample_explanation_ids.length).toBeGreaterThan(0);
      expect(result.result.consumed_leaves).toEqual(expect.arrayContaining([
        expect.objectContaining({ leaf_kind: "source_interpretation_numeric_order",
          measurement: "valueBob", other_measurement: "valueX", value: order })
      ]));
      expect(result.index?.entries.length).toBeGreaterThan(0);
    }
  }
});

it("reports incomparable when only the second aligned subject has an incompatible measurement", () => {
  const base = finiteSource(), semantics = comparison("eq");
  const source = SourceSemanticInterpretationSchema.parse({ ...base,
    measurements: base.measurements!.map(row => row.id === "valueBob" ? { ...row, unit: "kg" } : row) });
  for (const alignments of [["rX", "rBob"], ["rBob", "rX"]]) {
    const { result } = execute(source, semantics, undefined, alignments, "rAlice");
    expect(result.result.outcome.status, JSON.stringify(result.result.outcome)).toBe("interpreted");
    expect(result.result.evaluation?.status).toBe("incomparable");
    expect(result.result.binding_results).toEqual([]);
    expect(result.result.consumed_leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ leaf_kind: "source_interpretation_numeric_order",
        measurement: "valueBob", other_measurement: "valueAlice", value: "incomparable" })
    ]));
  }
});

it("retains comparator direction, non-strict ties, extrema and an unfunded finite obligation", () => {
  const base = finiteSource();
  for (const [operation, status] of [["lt", "refuted"], ["le", "supported"], ["gt", "refuted"], ["ge", "supported"]] as const) {
    const { result } = execute(base, comparison(operation));
    expect(result.result.evaluation?.status, JSON.stringify(result.result.outcome)).toBe(status);
  }
  const reversed = { ...base, measurements: base.measurements!.map(row => row.id === "valueAlice" ? { ...row, value: "1" } : row) };
  expect(execute(reversed, comparison("lt")).result.result.evaluation?.status).toBe("supported");
  for (const operation of ["minimum", "maximum"] as const) {
    const semantics: SourceSemanticQuery = { ...comparison("eq"), variables: [{ id: "actor", sort: "entity" }],
      return_variables: ["actor"], evaluation: { kind: "comparison", domain: "people", operation, left: "actor",
        strict: false, metric: "speed", unit: "ms", context: "lab", scope: "asserted" } };
    const ties = execute(base, semantics, { ...SOURCE_SEMANTIC_REASONING_BUDGET,
      work_units: 10_000_000, memory_bytes: 60_000_000, finalization_reserve: 50_000 }).result.result;
    expect(ties.evaluation?.status, JSON.stringify(ties.outcome)).toBe("supported");
    expect(ties.binding_results?.map(row => row.returned.actor?.node_id).sort()).toEqual(["rAlice", "rBob"]);
  }
  const incompatible = { ...base, measurements: base.measurements!.map(row => row.id === "valueBob" ? { ...row, unit: "kg" } : row) };
  const incomparable = execute(incompatible, comparison("eq")).result.result;
  expect(incomparable.evaluation?.status).toBe("incomparable");
  expect(incomparable.binding_results).toEqual([]);
  const deniedQuery = comparison("eq"), deniedC = execute(base, deniedQuery).correspondence;
  const denied = executeSourceSemanticInterpretation({ source_interpretation: base, query_semantics: deniedQuery,
    semantic_correspondence: deniedC, original_query: FINITE_QUERY, workspaceId: "ws", scope: "project",
    authorizedScopes: [], asOf: CLOCK });
  expect(denied.result.outcome).toEqual({ status: "invalid", reason: "unauthorized_scope" });
  expect(denied.index).toBeNull();
  expect(denied.result.consumed_leaves).toEqual([]);
  const large = measuredSource(46), semantics = comparison("eq");
  const correspondence = finiteCorrespondence(large, semantics);
  // A tiny finite request never turns an unfinished comparison into empty success.
  const partial = executeSourceSemanticInterpretation({ source_interpretation: large, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: FINITE_QUERY, workspaceId: "ws", scope: "project",
    authorizedScopes: ["project"], asOf: CLOCK,
    request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: sourceSemanticInterpretationIdentity(large, sha), query_semantics_id: sourceSemanticQueryIdentity(semantics, sha),
      semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, sha), original_query: FINITE_QUERY,
      budget: { ...SOURCE_SEMANTIC_REASONING_BUDGET, work_units: 1000, finalization_reserve: 10 }, output_byte_limit: 1000000 } });
  expect(partial.result.outcome.status).toBe("resource_exhausted");
  expect(partial.result.binding_results).toBeUndefined();
  expect(partial.index).toBeNull();
});
