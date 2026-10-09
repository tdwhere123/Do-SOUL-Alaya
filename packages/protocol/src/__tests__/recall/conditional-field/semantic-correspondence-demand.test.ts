import { expect, it } from "vitest";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "../../../conversation/utterance-attribution.js";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY,
  SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_POLICY_CONTRACT,
  SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SourceSemanticCorrespondenceDemandSelectionSchema,
  SourceSemanticCorrespondencePreparationOptionsSchema,
  SourceSemanticCorrespondenceGenerationPolicySchema,
  buildSourceSemanticCorrespondenceEndpointCatalog,
  materializeSourceSemanticCorrespondenceAssessment,
  materializeSourceSemanticQueryMeaning,
  sourceSemanticCorrespondenceCacheMaterial,
  sourceSemanticCorrespondenceCoverage,
  sourceSemanticCorrespondenceDemand,
  sourceSemanticCorrespondenceGenerationPolicies,
  sourceSemanticQueryBranchViews
} from "../../../recall/conditional-field/index.js";
import type { SourceSemanticInterpretation } from "../../../garden/source-semantic-interpretation.js";
import type { SourceSemanticQuery } from "../../../recall/conditional-field/semantic-query.js";

const digest = `sha256:${"a".repeat(64)}`;
const identity = {
  original_query_digest: digest, approved_fixed_context: null,
  attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, producer_id: "qp", producer_version: "1"
};
const ORIGINAL = "How many things did Maya wash or mend?";
const interpretation = {
  frames: [{
    id: "fWash",
    predicate_support: { kind: "explicit", reading: "wash", mentions: ["mWash"] },
    slots: [{ id: "agent", role_reading: "agent", support: [] }]
  }],
  referents: [{ id: "rMaya", referent_kind: "grouped", mentions: ["mMaya"] }]
} as unknown as SourceSemanticInterpretation;

function statement(predicate: string, args: object[], extra: object = {}) {
  return { kind: "statement", key: predicate, predicate, arguments: args, ...extra };
}

function washMendQuery() {
  return materializeSourceSemanticQueryMeaning({
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    gaps: [
      { kind: "unsupported_meaning", affected_ids: ["wash", "mend"],
        support: [{ kind: "query_text", excerpt: "did Maya wash or mend" }] },
      { kind: "aggregate", affected_ids: [],
        support: [{ kind: "query_text", excerpt: "How many" }] }
    ],
    requested_operation: { reading: "count", support: { kind: "query_text", excerpt: "How many" } },
    entities: [
      { kind: "named", key: "maya", excerpt: "Maya" },
      { kind: "free", key: "thing", excerpt: "things" }
    ],
    alternatives: [{
      conditions: [],
      evidence_inputs: [
        { conditions: [statement("wash", [
          { role: "agent", target: { kind: "reference", key: "maya" }, excerpt: "Maya" },
          { role: "theme", target: { kind: "reference", key: "thing" }, excerpt: "things" }
        ])] },
        { conditions: [statement("mend", [
          { role: "agent", target: { kind: "reference", key: "maya" }, excerpt: "Maya" },
          { role: "theme", target: { kind: "reference", key: "thing" }, excerpt: "things" }
        ])] }
      ]
    }]
  }, { ...identity, original_query: ORIGINAL });
}

function catalogFor(query: SourceSemanticQuery) {
  return buildSourceSemanticCorrespondenceEndpointCatalog(query, [
    { source_interpretation_handle: "source1", interpretation }
  ]);
}

function branchPolicy(input: number) {
  const policy = SourceSemanticCorrespondenceGenerationPolicySchema.parse({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_POLICY_CONTRACT,
    kind: "branch_demand", alternative: 0, target: { kind: "evidence", input }
  });
  if (policy.kind !== "branch_demand") throw new Error("expected a branch demand");
  return policy;
}

it("enumerates nonempty native evidence branches and skips an empty answer view", () => {
  const query = washMendQuery();
  expect(sourceSemanticQueryBranchViews(query.alternatives[0]!).map((view) => [
    view.target, view.alternative.frames.map((frame) => frame.id)
  ])).toEqual([
    [{ kind: "answer" }, []],
    [{ kind: "evidence", input: 0 }, ["wash"]],
    [{ kind: "evidence", input: 1 }, ["mend"]]
  ]);
  expect(query.gaps.map((gap) => gap.kind)).toEqual(["unsupported_meaning", "aggregate"]);
  expect(sourceSemanticCorrespondenceGenerationPolicies(query)).toEqual([
    SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY
  ]);
  expect(sourceSemanticCorrespondenceGenerationPolicies(query, {
    kind: "query_branches", maximum_demands_per_interpretation: 2
  })).toEqual([branchPolicy(0), branchPolicy(1)]);
  expect(sourceSemanticCorrespondenceGenerationPolicies(query, {
    kind: "query_branches", maximum_demands_per_interpretation: 1
  })).toEqual([branchPolicy(0)]);
  expect(SourceSemanticCorrespondenceDemandSelectionSchema.safeParse({
    kind: "query_branches", maximum_demands_per_interpretation: 0
  }).success).toBe(false);
});

it("pairs correspondence_demand with correspondence_cap and permits a zero cap", () => {
  expect(SourceSemanticCorrespondencePreparationOptionsSchema.parse({})).toEqual({});
  expect(SourceSemanticCorrespondencePreparationOptionsSchema.safeParse({
    correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 }
  }).success).toBe(false);
  expect(SourceSemanticCorrespondencePreparationOptionsSchema.safeParse({ correspondence_cap: 1 }).success).toBe(false);
  expect(SourceSemanticCorrespondencePreparationOptionsSchema.parse({
    correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
    correspondence_cap: 0
  }).correspondence_cap).toBe(0);
  expect(SourceSemanticCorrespondencePreparationOptionsSchema.safeParse({
    correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 },
    correspondence_cap: 33
  }).success).toBe(false);
});

it("derives independent wash and mend demands that share the Maya referent", () => {
  const query = washMendQuery();
  const catalog = catalogFor(query);
  const policy = {
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_POLICY_CONTRACT,
    kind: "branch_demand" as const, alternative: 0, target: { kind: "evidence" as const, input: 0 }
  };
  const wash = sourceSemanticCorrespondenceDemand(query, catalog, policy);
  const mend = sourceSemanticCorrespondenceDemand(query, catalog, branchPolicy(1));
  policy.alternative = 9;
  expect(wash.generation_policy).toMatchObject({ kind: "branch_demand", alternative: 0 });
  expect(wash.query_refs.frames).toEqual(["wash"]);
  expect(mend.query_refs.frames).toEqual(["mend"]);
  expect(wash.demanded_handles).toHaveLength(4);
  expect(mend.demanded_handles).toHaveLength(4);
  expect(catalog.query_endpoints).toHaveLength(7);
  const maya = catalog.query_endpoints.find((row) => row.kind === "referent" && row.variable === "maya")!.handle;
  expect(wash.demanded_handles).toContain(maya);
  expect(mend.demanded_handles).toContain(maya);
  expect(wash.demanded_handles.filter((handle) => handle !== maya)
    .some((handle) => mend.demanded_handles.includes(handle))).toBe(false);
  expect(sourceSemanticCorrespondenceDemand(query, catalog, SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY)
    .demanded_handles).toEqual(catalog.query_endpoints.map((row) => row.handle));
  expect(() => sourceSemanticCorrespondenceDemand(query, catalog, branchPolicy(9)))
    .toThrow(/target is not in the query/u);
  expect(() => sourceSemanticCorrespondenceDemand(query, catalog, {
    ...branchPolicy(0), alternative: 4
  })).toThrow(/alternative is not in the query/u);
});

it("includes a named reporter from a governing reported operator outside the evidence frame roles", () => {
  const query = materializeSourceSemanticQueryMeaning({
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    requested_operation: { reading: "identify", support: { kind: "query_text", excerpt: "Who" } },
    alternatives: [{
      conditions: [{ kind: "reported", key: "report",
        reporter: { kind: "named", key: "mira", excerpt: "Mira" }, content: statement("left", []) }],
      evidence_inputs: [{ conditions: [{ kind: "occurrence", key: "left" }] }]
    }]
  }, { ...identity, original_query: "Who left, according to Mira?" });
  const catalog = catalogFor(query);
  const demand = sourceSemanticCorrespondenceDemand(query, catalog, branchPolicy(0));
  expect(demand.query_refs.frames).toEqual(expect.arrayContaining(["report", "left"]));
  const mira = catalog.query_endpoints.find((row) => row.kind === "referent" && row.variable === "mira");
  expect(mira).toBeDefined();
  expect(demand.demanded_handles).toContain(mira!.handle);
  expect(demand.query_refs.variables).toContain("mira");
});

it("closes governing siblings into the demanded query refs", () => {
  const query = materializeSourceSemanticQueryMeaning({
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    requested_operation: { reading: "identify", support: { kind: "query_text", excerpt: "Who" } },
    alternatives: [{
      conditions: [{ kind: "conditional", key: "condition",
        antecedent: statement("invited", []), consequent: statement("spoke", []) }],
      evidence_inputs: [{ conditions: [{ kind: "occurrence", key: "spoke" }] }]
    }]
  }, { ...identity, original_query: "Who spoke if invited?" });
  const catalog = catalogFor(query);
  const demand = sourceSemanticCorrespondenceDemand(query, catalog, branchPolicy(0));
  expect(demand.query_refs.frames).toEqual(["condition", "invited", "spoke"]);
  expect(demand.demanded_handles.length).toBeGreaterThan(0);
  expect(demand.demanded_handles.every((handle) => catalog.query_endpoints.some((row) => row.handle === handle)))
    .toBe(true);
});

it("materializes only demanded endpoints and records unassessed remainder without filling unresolved", () => {
  const query = washMendQuery();
  const catalog = catalogFor(query);
  const demand = sourceSemanticCorrespondenceDemand(query, catalog, branchPolicy(0));
  const frame = catalog.source_endpoints.find((row) => row.kind === "frame")!;
  const predicate = catalog.query_endpoints.find((row) =>
    row.kind === "predicate" && demand.demanded_handles.includes(row.handle))!;
  const envelope = {
    original_query: ORIGINAL, source_interpretation_id: digest, query_semantics_id: digest,
    producer_id: "ap", producer_version: "1"
  };
  const assessments = demand.demanded_handles.map((handle) => handle === predicate.handle
    ? { query: handle, status: "supported" as const, equivalents: [{
      source: frame.handle, query_excerpt: "wash", source_semantic_support: [], grounding: "Local wash frame."
    }] }
    : { query: handle, status: "unresolved" as const, query_excerpt: "Maya", explanation: "Open." });
  const body = {
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
    source_interpretation_handle: "source1", assessments
  };
  const semantic_correspondence = materializeSourceSemanticCorrespondenceAssessment(body, catalog, envelope, demand);
  expect(semantic_correspondence.correspondences).toHaveLength(1);
  const coverage = sourceSemanticCorrespondenceCoverage(catalog, demand, body);
  expect(coverage.demanded).toEqual(demand.demanded_handles);
  expect(coverage.assessed).toEqual(demand.demanded_handles);
  expect(coverage.supported).toEqual([predicate.handle]);
  expect(coverage.unresolved).toEqual(demand.demanded_handles.filter((handle) => handle !== predicate.handle));
  expect(coverage.unassessed).toEqual(catalog.query_endpoints.map((row) => row.handle)
    .filter((handle) => !demand.demanded_handles.includes(handle)));
  expect(coverage.unassessed).toHaveLength(3);
  expect(coverage.unresolved.some((handle) => coverage.unassessed.includes(handle))).toBe(false);
  expect(() => materializeSourceSemanticCorrespondenceAssessment(body, catalog, envelope))
    .toThrow(/missing query endpoint assessment/u);
  expect(() => materializeSourceSemanticCorrespondenceAssessment({
    ...body, assessments: assessments.slice(1)
  }, catalog, envelope, demand)).toThrow(/missing query endpoint assessment/u);
  const extra = catalog.query_endpoints.find((row) => !demand.demanded_handles.includes(row.handle))!;
  expect(() => materializeSourceSemanticCorrespondenceAssessment({
    ...body, assessments: [...assessments, {
      query: extra.handle, status: "unresolved", query_excerpt: "Maya", explanation: "Invented remainder."
    }]
  }, catalog, envelope, demand)).toThrow(/extra query endpoint assessment/u);
  expect(() => sourceSemanticCorrespondenceCoverage(catalog, demand, {
    ...body, assessments: assessments.slice(1)
  })).toThrow(/missing query endpoint assessment/u);
  expect(() => sourceSemanticCorrespondenceCoverage(catalog, demand, {
    ...body, assessments: [...assessments, {
      query: extra.handle, status: "unresolved", query_excerpt: "Maya", explanation: "Invented remainder."
    }]
  })).toThrow(/extra query endpoint assessment/u);
});

it("keeps many-to-many equivalents on a demanded predicate and distinguishes cache identities", () => {
  const query = washMendQuery();
  const catalog = catalogFor(query);
  const demand = sourceSemanticCorrespondenceDemand(query, catalog, branchPolicy(0));
  const frames = catalog.source_endpoints.filter((row) => row.kind === "frame");
  const predicate = catalog.query_endpoints.find((row) =>
    row.kind === "predicate" && demand.demanded_handles.includes(row.handle))!;
  const envelope = {
    original_query: ORIGINAL, source_interpretation_id: digest, query_semantics_id: digest,
    producer_id: "ap", producer_version: "1"
  };
  const assessments = demand.demanded_handles.map((handle) => handle === predicate.handle
    ? { query: handle, status: "supported" as const, equivalents: frames.map((frame) => ({
      source: frame.handle, query_excerpt: "wash", source_semantic_support: [], grounding: "Cited local frame."
    })) }
    : { query: handle, status: "unresolved" as const, query_excerpt: "Maya", explanation: "Open." });
  expect(materializeSourceSemanticCorrespondenceAssessment({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
    source_interpretation_handle: "source1", assessments
  }, catalog, envelope, demand).correspondences).toHaveLength(frames.length);
  const q = digest;
  const h = `sha256:${"b".repeat(64)}`;
  expect(sourceSemanticCorrespondenceCacheMaterial({
    query_semantics_id: q, source_interpretation_id: h,
    generation_policy: SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY
  })).toBe(`${q}:${h}`);
  expect(sourceSemanticCorrespondenceCacheMaterial({
    query_semantics_id: q, source_interpretation_id: h, generation_policy: branchPolicy(0)
  })).not.toBe(`${q}:${h}`);
  expect(sourceSemanticCorrespondenceCacheMaterial({
    query_semantics_id: q, source_interpretation_id: h, generation_policy: branchPolicy(0)
  })).not.toBe(sourceSemanticCorrespondenceCacheMaterial({
    query_semantics_id: q, source_interpretation_id: h, generation_policy: branchPolicy(1)
  }));
  expect(sourceSemanticCorrespondenceCacheMaterial({
    query_semantics_id: `sha256:${"c".repeat(64)}`, source_interpretation_id: h,
    generation_policy: branchPolicy(0)
  })).not.toBe(sourceSemanticCorrespondenceCacheMaterial({
    query_semantics_id: q, source_interpretation_id: h, generation_policy: branchPolicy(0)
  }));
});
