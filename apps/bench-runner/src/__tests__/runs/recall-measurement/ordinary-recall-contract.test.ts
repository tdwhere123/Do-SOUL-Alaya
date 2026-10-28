import { expect, it } from "vitest";
import { nativeRecallArchiveSemantics, OrdinaryRecallMultiSourceConfigSchema } from
  "../../../runs/recall-measurement/ordinary/ordinary-recall-contract.js";

const fixture = {
  capture_contract: "ordinary-recall-local-capture-v2", candidate: "a".repeat(40), tree: "b".repeat(40),
  implementation_revision: "a".repeat(40), snapshot_path: "/authored-format-control.sqlite",
  snapshot_sha256: "c".repeat(64), workspace_id: "workspace", run_id: "run",
  first_request: { query: "question", scope_class: "project", dimension: null, domain_tags: null,
    max_results: 8, source_observed_at: "2026-01-01T00:00:00.000Z", enumeration_policy: "native_query",
    result_kind_view: "source_only", protocol_version: 1, supports_source_evidence: true },
  bounds: { membership_calls: 2, payload_expansion_calls: 8, total_recall_calls: 10,
    payload_byte_budget: 4096, public_envelope_observation_bytes: 1048576,
    default_native_request: { schema_version: 1, work_units: 10000, memory_bytes: 1000000,
      page_budget: 8, finalization_reserve: 100, min_envelope: 10 } },
  provider_calls: 0, consumer_calls: 0
};

it.each([
  ["27.0.0", "ordinary-native-field.v4"], ["28.0.0", "ordinary-native-field.v5"],
  ["29.0.0", "ordinary-native-field.v6"]
])("admits only the reviewed native archive version pair for %s", (version, semantics) => {
  expect(nativeRecallArchiveSemantics(version)).toBe(semantics);
  const config = { ...fixture, protocol_package_version: version, public_semantics: semantics };
  expect(OrdinaryRecallMultiSourceConfigSchema.safeParse(config).success).toBe(true);
  for (const other of ["ordinary-native-field.v4", "ordinary-native-field.v5", "ordinary-native-field.v6"]) {
    if (other !== semantics) expect(OrdinaryRecallMultiSourceConfigSchema.safeParse({ ...config,
      public_semantics: other }).success).toBe(false);
  }
  expect(OrdinaryRecallMultiSourceConfigSchema.safeParse({ ...config,
    first_request: { ...fixture.first_request, enumeration_policy: "canonical" }
  }).success).toBe(false);
});

it.each(["26.0.0", "27.1.0", "28.1.0", "29.1.0", "30.0.0"])("does not infer native archive support for %s", version => {
  expect(nativeRecallArchiveSemantics(version)).toBeUndefined();
  expect(OrdinaryRecallMultiSourceConfigSchema.safeParse({ ...fixture,
    protocol_package_version: version, public_semantics: "ordinary-native-field.v5"
  }).success).toBe(false);
});
