import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });

import {
  SoulInterpretationResponseSchema, packSourceSemanticAcquisition, packSourceSemanticQueryPreparation,
  sourceSemanticAccessPhases, sourceSemanticAcquisitionNotRun, sourceSemanticExecution,
  type SourceSemanticAcquisitionPhase, type SourceSemanticQueryPreparation
} from "@do-soul/alaya-protocol";
type SourceSemanticAcquisition = NonNullable<SourceSemanticAcquisitionPhase["result"]>;
import type { SemanticChainConfig } from "../../../runs/recall-measurement/contract.js";
import {
  assertSemanticChainSourceObservation, SemanticChainSourceObservationError
} from "../../../runs/recall-measurement/source-index-observation.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const PROFILE = { provider_kind: "local_onnx", model_id: "fixture-local-model", model_revision: "fixture-v1",
  artifact_digest: digest("a"), tokenizer_revision: "simulated-token-count-v1", dimensions: 3,
  preprocessing: "exact-utf8", normalization: "none", max_input_tokens: 32,
  windowing: "utf8-byte-windows.v1" as const, window_bytes: 4096 };
const SELECTED = { selection_revision: 1, config_id: digest("b"), profile_id: digest("c"), profile: PROFILE };
const BINDING = { workspace_id: "workspace-1", selection_revision: 1, config_id: digest("b"), profile_id: digest("c"),
  generation_id: digest("5"), source_epoch: 1, dimensions: 3 };
const COVERAGE = { discovery: "complete" as const, source_interpretation: "unexercised" as const,
  query_semantics: "unexercised" as const, semantic_correspondence: "unexercised" as const,
  conditional_computation: "unexercised" as const, payload: "complete" as const };
const WORK = { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 };
const ZERO_COUNTS = { attempted: 0, admitted: 0, duplicate: 0, rejected: 0, scope_denied: 0, native_unknown: 0,
  resource_refused: 0, stale: 0, nomination_limit: 0 };

function enabledConfig(): SemanticChainConfig {
  return { workspace_id: "workspace-1", source_index: { kind: "cached_local", cache_root: "/tmp/unused",
    model_id: "fixture-local-model", index: { configuration: { revision: "fixture-v1", profile: PROFILE },
      config_id: digest("b"), profile_id: digest("c"), selection_revision: 1, generation_id: digest("5"),
      source_epoch: 1, status: "ready", enumeration_complete: true, target_count: 1, completed_count: 1 },
    preparation_path: "/tmp/unused", preparation_identity: "a".repeat(64) } } as SemanticChainConfig;
}

function preparation(): SourceSemanticQueryPreparation {
  return { status: "ready", reason: null, navigation_digest: digest("1"), selected: SELECTED,
    method: "local_inference", submitted_inputs: 1, token_count: 2, external_api_attempts: 0,
    binding_work: "unknown", execution_work: "unknown", elapsed_ms: 0 };
}

function vector(overrides: Partial<SourceSemanticAcquisition["vector"]> = {}): SourceSemanticAcquisition["vector"] {
  return { completion: "complete", state: { status: "ready", binding: BINDING }, reason: null, inspected_windows: 1,
    invalid_windows: 0, validation: "validated", ranking: "exact_over_inspected_subset",
    input: { status: "available", profile_id: digest("c"), input_digest: digest("1") }, ...overrides };
}

function acquisition(result: SourceSemanticAcquisition, extras: Partial<SourceSemanticAcquisitionPhase> = {}):
  SourceSemanticAcquisitionPhase {
  return { policy: "source-index-interleaved-prefix.v1", status: "executed", reason: null,
    allowance: { max_attempts: 8, max_roots: 4, max_vector_windows: 64 },
    budget: { work_units: 1000, memory_bytes: 1000 }, result, accounting: "complete", ...extras };
}

function result(overrides: {
  vector?: Partial<SourceSemanticAcquisition["vector"]>;
  accounting?: Partial<SourceSemanticAcquisition["accounting"]>;
  resource_refusals?: SourceSemanticAcquisition["resource_refusals"];
  completion?: SourceSemanticAcquisition["completion"];
} = {}): SourceSemanticAcquisition {
  const next = vector(overrides.vector);
  return { policy: "source-index-interleaved-prefix.v1", navigation_digest: digest("1"),
    completion: overrides.completion ?? (next.completion === "complete" ? "complete" : "partial"),
    nominations: [], accounting: { ...ZERO_COUNTS, ...overrides.accounting },
    resources: { work: 1, memory_bytes: 1, native_bytes: 0, sql_internal_work: "unknown" },
    resource_refusals: overrides.resource_refusals ?? [],
    lexical: { completion: "complete", index_coverage: "partial", reason: null, limitations: [], tokenization: null },
    vector: next, limitations: ["nominations_are_not_source_absence", "sqlite_internal_work_unknown",
      "native_deadline_and_interruption_require_daemon_integration", "caller_owned_read_snapshot_required",
      "lexical_corpus_coverage_untracked"] };
}

function prepareQuery(access: ReturnType<typeof packedAccess> | null = packedAccess()) {
  const parsed = SoulInterpretationResponseSchema.parse({
    operation: "prepare_query", query_semantics_status: { status: "unavailable", reason: "absent" },
    ...(access === null ? {} : { access }), candidates: [], truncated: false, coverage: COVERAGE, work: WORK,
    execution: sourceSemanticExecution()
  });
  if (parsed.operation !== "prepare_query") throw new Error("expected prepare_query receipt");
  return parsed;
}

function packedAccess(query = preparation(), phase = acquisition(result())) {
  return {
    contract: "source-semantic-access-v2" as const,
    phases: [2, packSourceSemanticQueryPreparation(query), packSourceSemanticAcquisition(phase), null] as const,
    policy: "query-conditioned-v1" as const, input_id: digest("1"), pool_id: digest("1"),
    observed_source_count: 0, observed_interpretation_count: 0, source_candidates: [], interpretation_candidates: [],
    unvisited_sources: false, unvisited_interpretations: false, stopping_reasons: [],
    trace: { kind: "preparation_page" as const, source_offset: 0, interpretation_offset: 0,
      omitted_source_count: 0, omitted_interpretation_count: 0 }
  };
}

function expectUnavailable(response: ReturnType<typeof prepareQuery>, reason: string) {
  expect(() => assertSemanticChainSourceObservation(enabledConfig(), response))
    .toThrow(SemanticChainSourceObservationError);
  try {
    assertSemanticChainSourceObservation(enabledConfig(), response);
  } catch (error) {
    expect(error).toMatchObject({ failure: { kind: "unavailable", reason, response } });
    return;
  }
  throw new Error("expected unavailable observation");
}

it("admits a complete vector scan instead of treating generation ready as query-scan completion", () => {
  const response = prepareQuery();
  expect(() => assertSemanticChainSourceObservation(enabledConfig(), response)).not.toThrow();
  expect(sourceSemanticAccessPhases(response.access!).acquisition.result?.vector).toMatchObject({
    completion: "complete", reason: null, state: { status: "ready" }
  });
});

it("admits a product-bounded window_limit prefix without normalizing the receipt to complete", () => {
  const response = prepareQuery(packedAccess(preparation(), acquisition(result({
    vector: { completion: "partial", reason: "window_limit", inspected_windows: 1 }
  }))));
  expect(() => assertSemanticChainSourceObservation(enabledConfig(), response)).not.toThrow();
  const acquired = sourceSemanticAccessPhases(response.access!).acquisition.result;
  expect(acquired?.vector).toMatchObject({ completion: "partial", reason: "window_limit",
    ranking: "exact_over_inspected_subset", inspected_windows: 1 });
  expect(acquired?.completion).toBe("partial");
  expect(acquired?.vector.completion).not.toBe("complete");
});

it("rejects native_unknown admissions on a complete scan and on a window_limit prefix", () => {
  expectUnavailable(prepareQuery(packedAccess(preparation(), acquisition(result({
    accounting: { native_unknown: 1, attempted: 1, rejected: 1 }
  })))), "acquisition_incomplete");
  expectUnavailable(prepareQuery(packedAccess(preparation(), acquisition(result({
    vector: { completion: "partial", reason: "window_limit" }, accounting: { native_unknown: 1, attempted: 1, rejected: 1 }
  })))), "window_limit");
});

it.each([
  { reason: "fixture_unknown_partial", label: "unknown partial cause" },
  { reason: "scoring_budget", label: "unsupported scoring_budget partial" },
  { reason: "window_page_limit", label: "page limit that is not product window_limit" },
  { reason: "scan_did_not_advance", label: "unbounded nonadvancing scan" }
])("rejects $label", ({ reason }) => {
  expectUnavailable(prepareQuery(packedAccess(preparation(), acquisition(result({
    vector: { completion: "partial", reason }
  })))), reason);
});

it("rejects missing access, acquisition not_run, vector not_run, and vector unavailable", () => {
  expectUnavailable(prepareQuery(null), "access_receipt_missing");
  expectUnavailable(prepareQuery(packedAccess(preparation(), sourceSemanticAcquisitionNotRun("fixture_missing_acquisition"))),
    "fixture_missing_acquisition");
  expectUnavailable(prepareQuery(packedAccess(preparation(), acquisition(result({
    vector: { completion: "not_run", reason: "validation_not_run" }
  })))), "validation_not_run");
  expectUnavailable(prepareQuery(packedAccess(preparation(), acquisition(result({
    vector: { completion: "unavailable", reason: "invalid_query_vector" }
  })))), "invalid_query_vector");
});

it("keeps selected-profile mismatch distinct from unavailable acquisition", () => {
  const mismatch = prepareQuery(packedAccess({ ...preparation(), selected: { ...SELECTED, profile_id: digest("9") } },
    acquisition(result())));
  expect(() => assertSemanticChainSourceObservation(enabledConfig(), mismatch))
    .toThrow(SemanticChainSourceObservationError);
  try {
    assertSemanticChainSourceObservation(enabledConfig(), mismatch);
  } catch (error) {
    expect(error).toMatchObject({ failure: { kind: "mismatch", reason: "selected_profile_changed", response: mismatch } });
    expect(error).not.toMatchObject({ failure: { kind: "unavailable" } });
    return;
  }
  throw new Error("expected mismatch observation");
});

it("still applies validation, resource, and cost-accounting constraints to a window_limit prefix", () => {
  expectUnavailable(prepareQuery(packedAccess(preparation(), acquisition(result({
    vector: { completion: "partial", reason: "window_limit", invalid_windows: 1 }
  })))), "window_limit");
  expectUnavailable(prepareQuery(packedAccess(preparation(), acquisition(result({
    vector: { completion: "partial", reason: "window_limit" },
    resource_refusals: [{ stage: "vector", phase: "source vector validation and cosine" }]
  })))), "window_limit");
  expectUnavailable(prepareQuery(packedAccess(preparation(), acquisition(result({
    vector: { completion: "partial", reason: "window_limit" }
  }), { accounting: "partial" }))), "window_limit");
});
