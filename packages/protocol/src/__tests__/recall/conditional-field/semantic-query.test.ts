import { expect, it } from "vitest";
import {
  SourceSemanticQuerySchema, queryAlternativeConnected,
  type SourceSemanticQueryAlternative, type SourceSemanticQueryFrame,
  type SourceSemanticContextObligation, type SourceSemanticQueryVariable
} from "../../../recall/conditional-field/semantic-query.js";

const digest = `sha256:${"a".repeat(64)}`;
const role = (id: string, variable: string) => ({
  id, role_reading: id, target_variable: variable, support: { kind: "query_text" as const, excerpt: variable }
});
const query = (
  frames: SourceSemanticQueryFrame[],
  obligations: SourceSemanticContextObligation[] = [],
  variables: SourceSemanticQueryVariable[] = [
    { id: "parcel", sort: "entity" }, { id: "other", sort: "entity" },
    { id: "fPack", sort: "proposition" }, { id: "fInspect", sort: "proposition" }
  ]
) => ({
  contract: "source-semantic-query-v2" as const, original_query_digest: digest,
  producer_id: "qp", producer_version: "1", contract_version: "source-semantic-query-v2",
  variables, alternatives: [{ frames, context_obligations: obligations }] satisfies SourceSemanticQueryAlternative[],
  return_variables: ["parcel"], gaps: []
});

it("accepts a connected positive existential query", () => {
  const connected = query([{
    id: "qPack", variable: "fPack", predicate_reading: "pack",
    role_requirements: [role("object", "parcel")]
  }, {
    id: "qInspect", variable: "fInspect", predicate_reading: "inspect",
    role_requirements: [role("object", "parcel")]
  }], [{ frame: "qPack", kind: "asserted_at_source" }, { frame: "qInspect", kind: "asserted_at_source" }]);
  expect(SourceSemanticQuerySchema.parse(connected).alternatives).toHaveLength(1);
});

it("rejects a disconnected query instead of dropping the extra constraint", () => {
  const disconnected = query([{
    id: "qPack", variable: "fPack", predicate_reading: "pack",
    role_requirements: [role("object", "parcel")]
  }, {
    id: "qInspect", variable: "fInspect", predicate_reading: "inspect",
    role_requirements: [role("object", "other")]
  }]);
  expect(queryAlternativeConnected(disconnected.alternatives[0]!)).toBe(false);
  expect(SourceSemanticQuerySchema.safeParse(disconnected).success).toBe(false);
});

it("connects frames by incidence, not by sharing an obligation kind", () => {
  const sameKind = query([{
    id: "qPack", variable: "fPack", predicate_reading: "pack",
    role_requirements: [role("object", "parcel")]
  }, {
    id: "qInspect", variable: "fInspect", predicate_reading: "inspect",
    role_requirements: [role("object", "other")]
  }], [{ frame: "qPack", kind: "asserted_at_source" }, { frame: "qInspect", kind: "asserted_at_source" }]);
  expect(SourceSemanticQuerySchema.safeParse(sameKind).success).toBe(false);
  const incident = query([{
    id: "qPack", variable: "fPack", predicate_reading: "pack",
    role_requirements: [role("object", "parcel")]
  }, {
    id: "qInspect", variable: "fInspect", predicate_reading: "inspect",
    role_requirements: [role("object", "other")]
  }], [{
    frame: "qInspect", kind: "explicit_embedded_structure",
    incidence: { kind: "embedding", other_frame: "qPack", role: "content" }
  }]);
  expect(SourceSemanticQuerySchema.parse(incident).alternatives[0]?.context_obligations[0]?.incidence?.kind)
    .toBe("embedding");
});

it("records unsupported phenomena as gaps and rejects extra query operators", () => {
  const withGap = query([{
    id: "qPack", variable: "fPack", predicate_reading: "pack",
    role_requirements: [role("object", "parcel")]
  }], [], [{ id: "parcel", sort: "entity" }, { id: "fPack", sort: "proposition" }]);
  expect(SourceSemanticQuerySchema.parse({
    ...withGap, gaps: [{ kind: "universal_quantification", affected_ids: [], support: [] }]
  }).gaps[0]?.kind).toBe("universal_quantification");
  expect(SourceSemanticQuerySchema.safeParse({ ...withGap, program: { kind: "epsilon" } }).success).toBe(false);
  expect(SourceSemanticQuerySchema.safeParse({ ...withGap, seed_nodes: ["qPack"] }).success).toBe(false);
});
