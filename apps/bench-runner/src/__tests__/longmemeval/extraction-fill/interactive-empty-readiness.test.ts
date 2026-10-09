import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  return { warm: false, prepared: undefined as unknown, completion: undefined as unknown, writes: vi.fn() };
});
vi.mock("../../../runs/compile-seed/cache/cache-shard.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../runs/compile-seed/cache/cache-shard.js")>(),
  inspectCachedExtractionArtifact: () => ({ status: state.warm ? "hit" : "miss" })
}));
vi.mock("../../../runs/extraction/fill/fill-preparation.js", () => ({
  inspectExtractionFillPreparation: async () => state.prepared,
  inspectFillWindow: () => state.completion
}));
vi.mock("../../../runs/extraction/cache/extraction-cache-manifest.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../runs/extraction/cache/extraction-cache-manifest.js")>(),
  readExtractionCacheManifestIdentity: () => undefined, writeExtractionCacheManifest: state.writes
}));
vi.mock("../../../runs/compile-seed/http/semantic-provider-http.js", () => ({
  createSemanticProviderHttpExtractor: () => vi.fn(() => { throw new Error("dispatch forbidden"); }),
  isCompleteSemanticFinish: () => false, readNativeChatFailureResponse: () => undefined
}));
const { EXTRACTION_OPEN_SEMANTICS_GENERATION } = await import("../../../runs/extraction/request-artifact.js");
const { preflightSourceSemanticInteractive, parseSourceSemanticInteractivePreflight } = await import("../../../runs/extraction/fill/source-semantic-interactive-preflight.js");
const { hasCompleteExtractionFillAuthority } = await import("../../../runs/extraction/fill/fill-authority.js");
const { buildExtractionContentClosureIndex, computeExtractionContentClosureSha256, computeExtractionKeySetSha256 } =
  await import("../../../runs/extraction/content-closure.js");
const { executeOpenSemanticsInteractiveFill } = await import("../../../runs/extraction/fill/source-semantic-interactive-fill.js");
const config = { providerUrl: "https://api.stepfun.com/step_plan/v1", model: "step-3.5-flash-2603",
  requestProfile: "step-3.5-2603-low-json-schema-v1" as const, apiKey: null, sourcePacking: "complete-source" as const,
  openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
const prepared = { config, datasetRevision: "empty-population", sourceOccurrences: 1, unsupportedSourceOccurrences: 0,
  completion: { expectedTurns: 1 }, nativeSourceRecords: [{ population: "empty-population", native_record_id: "record-empty",
    source_id: "empty", source_version: "1", content_bytes: "", content_digest: "sha256:" + "a".repeat(64),
    corpus_digest: "a".repeat(64), source_observed_at: "2026-09-23T00:00:00Z", roles: [], units: [], repeated_assertion_text: false }],
  distinctExtractionTurns: [], executionExtractionTurns: [], requestedTurns: 1, variant: "longmemeval_s", windowOffset: 0, windowLimit: 100 };
state.prepared = prepared;

it("regenerates cold and warm empty-source readiness without any attempts or cache writes", async () => {
  const options = { cacheRoot: "/synthetic-unread-cache", variant: "longmemeval_s" as const,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  state.warm = false;
  const cold = await preflightSourceSemanticInteractive(options);
  state.warm = true;
  const warm = await preflightSourceSemanticInteractive(options);
  expect(cold).toMatchObject({ selected_requests: 0, cached_requests: 0, deterministic_requests: 1, provider_calls: 0 });
  expect(warm).toMatchObject({ selected_requests: 0, cached_requests: 1, deterministic_requests: 0, provider_calls: 0 });
  expect(warm.ready_requests).toEqual(cold.ready_requests);
  expect(parseSourceSemanticInteractivePreflight(warm)).toEqual(warm);
  expect(() => parseSourceSemanticInteractivePreflight({ ...warm, contract: "source-semantic-interactive-preflight-v2" })).toThrow();
  expect(state.writes).not.toHaveBeenCalled();
});

it("publishes a completed warm interactive sample as partial rather than complete authority", async () => {
  state.warm = true;
  const preflight = await preflightSourceSemanticInteractive({ cacheRoot: "/synthetic-unread-cache",
    variant: "longmemeval_s", sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION });
  const entries = preflight.selected_keys.map(cacheKey => ({ cacheKey, model: config.model,
    requestProfile: config.requestProfile, rawJsonSha256: "b".repeat(64), rawSignalCount: 0, parsedDraftCount: 0 }));
  state.completion = { expectedTurns: 1, validTurns: 1, missingTurns: 0, invalidTurns: 0, pendingTurns: 0,
    orphanTurns: 0, coverage: 1, expectedKeySetSha256: computeExtractionKeySetSha256(preflight.selected_keys),
    partialContentClosureSha256: null, contentClosureSha256: computeExtractionContentClosureSha256(entries),
    contentClosureIndex: buildExtractionContentClosureIndex(entries) };
  const result = await executeOpenSemanticsInteractiveFill({
    options: { variant: "longmemeval_s" }, prepared: prepared as never, cacheRoot: "/synthetic-unread-cache", concurrency: 1,
    writeLease: { assertOwned: () => undefined } as never,
    authority: { receipt: { action: "sample", source_preflight_digest: "a".repeat(64), sample_scope: { keys: preflight.selected_keys },
      limits: { output_token_field: "max_tokens", max_output_tokens: 4096 } }, snapshot: () => undefined } as never
  });
  expect(result.manifest.fill_status).toBe("in_progress");
  expect(result.manifest.content_closure_index).toBeUndefined();
  expect(result.manifest.content_closure_sha256).toBeUndefined();
  expect(hasCompleteExtractionFillAuthority(result.manifest)).toBe(false);
  expect(state.writes).toHaveBeenCalledOnce();
});
