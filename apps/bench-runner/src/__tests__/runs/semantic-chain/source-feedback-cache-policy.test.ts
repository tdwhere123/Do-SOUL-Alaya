import { resolve } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
  return { safe, strict };
});
vi.mock("../../../runs/semantic-proposal/fill.js", () => ({ readSemanticProposalResults: vi.fn() }));
// Pure policy/serialization verification never loads lifecycle effects or compiled artifacts.
vi.mock("../../../runs/semantic-chain/contract.js", () => ({}));
import { SourceSemanticInterpretationSchema, SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION,
  UNKNOWN_UTTERANCE_ATTRIBUTION, sourceSemanticInterpretationIdentity,
  sourceSemanticCorrespondenceGenerationPolicies } from "@do-soul/alaya-protocol";
import { fieldContractSha256, type SourceFeedbackCorrespondenceAction } from "@do-soul/alaya-core";
import { authoredQuerySemantics } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { createSourceFeedbackCorrespondenceCache } from "../../../runs/semantic-chain/source-feedback-correspondence-cache.js";
import { captureSourceExperimentValue } from "../../../runs/semantic-chain/source-experiment.js";

afterEach(() => { vi.clearAllMocks(); expect(isolation.safe.violations).toEqual([]); expect(isolation.strict.forbidden).toEqual([]); });
afterAll(() => { isolation.strict.restore(); isolation.safe.restore(); });
const original = "what was sent?";
const query = authoredQuerySemantics({ original_query: original, producer_id: "query", producer_version: "1" }, {
  variables: [{ id: "event", sort: "proposition" }], alternatives: [{ frames: [{ id: "qSend", variable: "event",
    predicate_reading: "send", role_requirements: [] }], context_obligations: [{ frame: "qSend", kind: "asserted_at_source" }] }],
  return_variables: [], gaps: []
}).query;
const interpretation = SourceSemanticInterpretationSchema.parse({ contract: "source-interpretation-v4",
  k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
  source: { source_id: "source", source_version: "1", content_digest: `sha256:${fieldContractSha256("sent")}`,
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION }, producer_id: "source", producer_version: "1", contract_version: "source-interpretation-v4",
  mentions: [{ id: "mSend", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" }, text: "sent", utf8_span: [0, 4] }],
  referents: [], frames: [{ id: "fSend", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [],
    predicate_support: { kind: "explicit", reading: "send", mentions: ["mSend"] }, slots: [], bindings: [] }],
  operators: [], gaps: [], entry_roots: ["fSend"], asserted_at_scope: ["fSend"] });
const descriptor = { interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256),
  source_id: "source", source_version: "1", content_digest: interpretation.source.content_digest,
  producer_id: "source", producer_version: "1", contract_version: "source-interpretation-v4", interpretation };
const producer = { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1", provider_url: "http://127.0.0.1:9",
  producer_id: "correspondence", producer_version: "1" };
const budget = { schema_version: 1 as const, work_units: 1_000_000, memory_bytes: 80_000_000, page_budget: 100_000,
  finalization_reserve: 10_000, min_envelope: 10 };
function action(policy_id: string): SourceFeedbackCorrespondenceAction {
  return { action_id: "action", demand_id: "demand", parent_entitlement_id: "parent", request: { kind: "prepare_correspondence",
    policy_id, origin_action_id: "discovery", origin_exposure_id: "exposure", access_hint: "sent", query_handle: "query-lease",
    original_query: original, query_semantics: query, descriptor, budget } };
}

it("reuses exactly the scoped seed request policy, producer, physical root and output limit", async () => {
  const correspondence_demand = { kind: "query_branches" as const, maximum_demands_per_interpretation: 1 };
  const generation_policy = sourceSemanticCorrespondenceGenerationPolicies(query, correspondence_demand)[0]!;
  const input = { cache_root: "/owned/physical-c-cache", max_output_tokens: 4096, producer,
    correspondence_demand, correspondence_cap: 1, generation_policy };
  const host = createSourceFeedbackCorrespondenceCache(input);
  const reader = vi.mocked(readSemanticProposalResults);
  reader.mockImplementation((workset, _root, tokens) => materializeSemanticProposalLines(workset, tokens)
    .map(line => ({ line, status: "unattempted" as const })));
  const result = await host.prepare(action(host.policy_id));
  const expected = { ...producer, contract: "source-semantic-proposal-workset-v3" as const, kind: "semantic_correspondence" as const,
    items: [{ original_query: original, admitted_query_semantics: query, generation_policy,
      source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation }] }] };
  expect(reader).toHaveBeenCalledExactlyOnceWith(expected, resolve(input.cache_root), 4096, expect.anything());
  expect(result).toMatchObject({ status: "unavailable", reason: "unattempted", new_dispatches: 0,
    cache_key: materializeSemanticProposalLines(expected, 4096)[0]!.key, historical_production: { status: "unknown" } });
  for (const changed of [{ max_output_tokens: 2048 }, { cache_root: "/different/physical-cache" }, { correspondence_cap: 2 },
    { producer: { ...producer, producer_version: "2" } }]) {
    expect(createSourceFeedbackCorrespondenceCache({ ...input, ...changed }).policy_id).not.toBe(host.policy_id);
  }
});

it("preserves omitted versus explicitly supplied full-catalog policy bytes and rejects an unpaired scope", async () => {
  const base = { cache_root: "/owned/cache", max_output_tokens: 4096, producer };
  const omitted = createSourceFeedbackCorrespondenceCache(base);
  const explicit = createSourceFeedbackCorrespondenceCache({ ...base,
    generation_policy: sourceSemanticCorrespondenceGenerationPolicies(query)[0]! });
  expect(explicit.policy_id).not.toBe(omitted.policy_id);
  const reader = vi.mocked(readSemanticProposalResults);
  reader.mockImplementation(workset => { expect(workset.items[0]).not.toHaveProperty("generation_policy"); return []; });
  // A malformed reader outcome is unknown, never a successful absence or an alternate cache search.
  expect(await omitted.prepare(action(omitted.policy_id))).toMatchObject({ status: "unknown", reason: "cache_read_failed" });
  expect(reader).toHaveBeenCalledTimes(1);
  expect(() => createSourceFeedbackCorrespondenceCache({ ...base, correspondence_cap: 1 })).toThrow(/must appear together/u);
});

it("captures caller-owned cache policy before later mutation without searching another physical root", async () => {
  const supplied = { cache_root: "/owned/exact-cache", max_output_tokens: 4096, producer: { ...producer } };
  const host = createSourceFeedbackCorrespondenceCache(supplied);
  supplied.cache_root = "/unselected/cache"; supplied.max_output_tokens = 8192; supplied.producer.model = "changed";
  const reader = vi.mocked(readSemanticProposalResults);
  reader.mockImplementation((workset, _root, tokens) => materializeSemanticProposalLines(workset, tokens)
    .map(line => ({ line, status: "unattempted" as const })));
  const result = await host.prepare(action(host.policy_id));
  expect(reader).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: producer.model }),
    resolve("/owned/exact-cache"), 4096, expect.anything());
  expect(result).toMatchObject({ status: "unavailable", new_dispatches: 0, historical_production: { status: "unknown" } });
});

it("retains arbitrary serializable diagnostics, cycles and exceptional getters without JSON silence", () => {
  const cause = new Error("nested", { cause: 17 });
  const error = Object.assign(new Error("outer", { cause }), { code: "CLEANUP", extra: 19n });
  Object.defineProperty(error, "hostile", { enumerable: true, get() { throw new Error("getter"); } });
  const cyclic: Record<string, unknown> = { error }; cyclic.self = cyclic;
  const encoded = JSON.parse(JSON.stringify(captureSourceExperimentValue(cyclic)));
  expect(encoded).toMatchObject({ error: { name: "Error", message: "outer", code: "CLEANUP",
    extra: { diagnostic_type: "bigint", value: "19" }, cause: { name: "Error", message: "nested", cause: 17 },
    hostile: { diagnostic_type: "unavailable" } }, self: { diagnostic_type: "circular" } });
});
