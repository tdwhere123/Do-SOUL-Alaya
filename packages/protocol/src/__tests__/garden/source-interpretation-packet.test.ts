import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { SourceInterpretationPacketSchema } from "../../garden/source-interpretation-packet.js";
import { assertSourceInterpretationPacketProfile, SourceInterpretationProfileSchema,
  sourceInterpretationProfileIdentity, sourceInterpretationRelationKey } from "../../garden/source-interpretation-profile.js";
import { QueryProgramSchema } from "../../recall/conditional-field/query.js";
import { sourceInterpretationDependsOnRecord } from "../../garden/source-interpretation-dependency.js";
import { memoryProductStateKey, ProductStateKeySchema, sourceRecallTarget } from "../../recall/conditional-field/product-identity.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const profile = SourceInterpretationProfileSchema.parse({ contract: "source-interpretation-profile-v1", description: "Event references and content",
  predicates: [{ symbol: "release", meaning: "A release event", governing_roles: [] },
    { symbol: "promise", meaning: "A commitment to content, not its fulfillment", governing_roles: ["content"] }],
  roles: [{ symbol: "accompaniment", meaning: "Associated independently asserted event" },
    { symbol: "content", meaning: "Proposition governed by the commitment" }] });
const proposition = (id: string, predicate: string, arguments_: readonly { role: string; target: string }[]) => ({
  id, predicate, implicit: true, predicate_mentions: [], assertion_ids: [1], arguments: arguments_ });
const packet = (governing: boolean) => SourceInterpretationPacketSchema.parse({ contract: "source-interpretation-v2",
  source_catalog_id: `sha256:${"a".repeat(64)}`, profile_id: sourceInterpretationProfileIdentity(profile, sha), mentions: [], referents: [], operators: [], roots: ["release", "promise"],
  propositions: [proposition("release", "release", [{ role: "accompaniment", target: "promise" }]),
    proposition("promise", "promise", [{ role: governing ? "content" : "accompaniment", target: "release" }])] });

it("permits mutually referring co-roots but rejects governing content escaping to a root", () => {
  expect(() => assertSourceInterpretationPacketProfile(packet(false), profile, sha)).not.toThrow();
  expect(() => assertSourceInterpretationPacketProfile(packet(true), profile, sha)).toThrow(/governed/u);
});

it("rejects a scope cycle even when it is reached through an ordinary reference", () => {
  const base = packet(false);
  const cyclic = SourceInterpretationPacketSchema.parse({ ...base, roots: ["release"],
    propositions: [base.propositions[0], proposition("promise", "promise", [{ role: "content", target: "nested" }]),
      proposition("nested", "promise", [{ role: "content", target: "promise" }])] });
  expect(() => assertSourceInterpretationPacketProfile(cyclic, profile, sha)).toThrow(/cyclic/u);
});

it("recognizes only exact workspace and source record dependencies without failing on unrelated malformed gist", () => {
  const target = sourceRecallTarget({ workspace_id: "workspace", root_kind: "source_record", root_id: "record",
    source_version: "1", content_digest: `sha256:${"a".repeat(64)}`, evidence_object_id: null });
  for (const contract of ["source-interpretation-v1", "published-source-interpretation-v2"]) {
    const gist = JSON.stringify({ contract, source_target: target });
    expect(sourceInterpretationDependsOnRecord(gist, "workspace", "record")).toBe(true);
    expect(sourceInterpretationDependsOnRecord(gist, "other", "record")).toBe(false);
    expect(sourceInterpretationDependsOnRecord(gist, "workspace", "other")).toBe(false);
  }
  for (const gist of ["{", "null", "{}", JSON.stringify({ contract: "other", source_target: target })]) {
    expect(sourceInterpretationDependsOnRecord(gist, "workspace", "record")).toBe(false);
  }
});

it("does not permit a local interpretation coordinate to masquerade as a memory product", () => {
  const memory = memoryProductStateKey({ workspace_id: "workspace", object_id: "object", source_revision: "1",
    program_state: "state", binding_context: "context", hypothesis_id: "H", time_state: "as_of" });
  expect(ProductStateKeySchema.safeParse(memory).success).toBe(true);
  expect(ProductStateKeySchema.safeParse({ ...memory,
    interpretation_node: { packet_id: "H", hypothesis_id: "H", node_id: "node" } }).success).toBe(false);
});

it("keeps all admitted symbols queryable including maximum JSON escaping without widening the query contract", () => {
  for (const symbol of ["p".repeat(64), "\u0001".repeat(64), '"\\'.repeat(32)]) {
    expect(SourceInterpretationProfileSchema.safeParse({ ...profile, predicates: [{ ...profile.predicates[0], symbol }] }).success).toBe(true);
    for (const kind of ["predicate", "role", "inverse_role"] as const) {
      expect(QueryProgramSchema.safeParse({ schema_version: 1, kind: "relation",
        relation_kind: sourceInterpretationRelationKey(kind, symbol), source_variable: "x", target_variable: "y",
        guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" },
        facet_mode: "same_path", threshold_milligrades: 0 }).success).toBe(true);
    }
  }
  for (const field of ["predicates", "roles"] as const) {
    expect(SourceInterpretationProfileSchema.safeParse({ ...profile, [field]: [{ ...profile[field][0], symbol: "p".repeat(65) }] }).success).toBe(false);
  }
  expect(() => sourceInterpretationRelationKey("predicate", "p".repeat(1024))).toThrow();
});
