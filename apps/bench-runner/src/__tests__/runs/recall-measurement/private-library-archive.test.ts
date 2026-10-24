import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => expect(isolation.violations).toEqual([]));
afterAll(() => isolation.restore());
import { SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SourceSemanticComparisonWorkerResultSchema, SourceSemanticReadableWorkerResultSchema,
  indexEntryCacheKey, sourceSemanticExecution, packSourceSemanticAcquisition, packSourceSemanticQueryPreparation,
  sourceSemanticProfiledAcquisitionNotRun, unavailableSourceQueryPreparation, type SourceSemanticAccessProfile } from "@do-soul/alaya-protocol";
import { assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResponse, preparedDeliveryId,
  projectSourceDisclosure, sourceSemanticAccessInputIdentity, sourceSemanticLibrarySourceEntry,
  sourceSemanticLibraryQueryIdentity, sourceSemanticLibraryRequestIdentity, SOURCE_SEMANTIC_LIBRARY_ORDER } from "@do-soul/alaya-core";
import { SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { admitPrivateSourceLibraryCapture } from "../../../runs/recall-measurement/private-library-capture.js";
import { admitDeliveredSources } from "../../../runs/recall-measurement/library-admission.js";
import { sourceLookupStores } from "../../../runs/snapshot/source-records/publish.js";
import { FirstExposureSession } from "../../../runs/measurement/first-exposure-session.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import { CLOCK, QUERY_BUDGET, SCOPES, WS, withIndexedSources } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-index-acquisition.test-support.js";

it("readmits artificial historical PRIVATE two-page bytes before labels and rejects family, context and source-binding alterations", async () => {
  const sources = Array.from({ length: 18 }, (_, index) => ({ id: `archive-${index}`, text: `needle ${index}`, vector: [1, 0, 0] }));
  await withIndexedSources(sources, async fixture => {
    const profile: SourceSemanticAccessProfile = { contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7",
      protocol_version: 9, order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-grouped-round-robin.v1",
      channels: "dual", declared_allowance: { max_attempts: 64, max_roots: 18, max_vector_windows: 64 } };
    const budget = { ...QUERY_BUDGET, work_units: 2000000, memory_bytes: 20000000 };
    const request = { operation: "recall" as const, accepts_unreviewed_conditional_results: true as const,
      original_query: "needle", semantic_correspondences: [], authorized_scopes: SCOPES, budget, output_byte_limit: 176340 };
    const status = { status: "unavailable" as const, reason: "absent" as const };
    const requestIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK,
      authorized_scopes: ["project"], original_query: "needle", query_semantics_status: status,
      semantic_correspondences: [], budget, output_byte_limit: request.output_byte_limit, candidate_profile: profile });
    const records = sourceLookupStores(fixture.database);
    const entries = sources.map(source => {
      const record = records.getCurrentRecord(WS, source.id)!;
      const entry = sourceSemanticLibrarySourceEntry({ workspaceId: WS, root_id: record.identity,
        source_version: record.source_version, content_digest: record.content_digest,
        evidence_object_id: record.evidence_object_id, hypothesis_id: "archived-source-only" });
      return { ...entry, target: { ...entry.target, span: { content_start: 0, content_end: Buffer.byteLength(source.text),
        retained_extent: "body" as const, content_complete: true, original_complete: true } } };
    });
    const preparation = packSourceSemanticQueryPreparation(unavailableSourceQueryPreparation("offline_fixture", "not_requested"));
    const acquisition = packSourceSemanticAcquisition(sourceSemanticProfiledAcquisitionNotRun(profile, "offline_fixture"));
    const exposure = new FirstExposureSession();
    let previous: Parameters<typeof recordSourceSemanticLibraryFirstExposure>[2];
    // Synthetic archived family built with retained historical authorities. No live
    // daemon selector, historical experiment rerun, or relabelled protocol10 result.
    const pages = [0, 5].map(offset => {
      const { index } = assembleSourceSemanticLibraryIndex({ query_id: sourceSemanticLibraryQueryIdentity("needle", profile.result_version),
        result_version: profile.result_version, snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_id: "archived-session",
        as_of: CLOCK, proof_groups: [], source_entries: entries, offset, truncated: false, open_residuals: false,
        authorized_scopes: ["project"], expires_at: "2099-01-01T00:00:00.000Z" });
      const worker = SourceSemanticComparisonWorkerResultSchema.parse({ kind: "recall", protocol_version: 9,
        request_identity: requestIdentity, delivery_id: preparedDeliveryId(requestIdentity, index), request_budget: budget,
        query_semantics_status: status, index, previews: Object.fromEntries(index.entries.map(entry => {
          const position = entries.findIndex(candidate => candidate.target.kind === "source_evidence" && entry.target.kind === "source_evidence"
            && candidate.target.root_id === entry.target.root_id);
          return [indexEntryCacheKey(entry), sources[position]!.text];
        })), total_count: index.entries.length, page_purpose: "membership", order: SOURCE_SEMANTIC_LIBRARY_ORDER,
        source_disclosures: Object.fromEntries(index.entries.map(entry => [indexEntryCacheKey(entry),
          projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: CLOCK, proof_use: "source_only" })])),
        slot_qualifiers: index.entries.map((_, index) => ({ index, evidence_kind: "source_evidence" })),
        discovery: { access: { contract: "source-semantic-access-v3", profile,
          phases: [2, preparation, acquisition, null], pool_id: `sha256:${"b".repeat(64)}`,
          input_id: sourceSemanticAccessInputIdentity({ original_query: "needle", budget, candidate_profile: profile }),
          observed_source_count: sources.length, observed_interpretation_count: 0, source_candidates: [], interpretation_candidates: [],
          trace: { kind: "library_selection", omitted_source_count: sources.length, omitted_interpretation_count: 0 },
          unvisited_sources: false, unvisited_interpretations: false, stopping_reasons: [] },
          eligible_source_count: sources.length, visited_source_pages: 1, visited_source_interpretation_pages: 1,
          visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
          unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, open_residuals: false, truncated: false },
        coverage: { discovery: "complete", source_interpretation: "unexercised", query_semantics: "unexercised",
          semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete" },
        work: { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 },
        execution: sourceSemanticExecution(preparation, acquisition) });
      const decoded = SourceSemanticReadableWorkerResultSchema.parse(JSON.parse(JSON.stringify(worker)));
      expect(decoded).toMatchObject({ kind: "recall", protocol_version: 9 });
      if (worker.kind !== "recall") throw new Error("archived recall required");
      const response = encodeSourceSemanticLibraryResponse(worker);
      if (response.operation !== "recall") throw new Error("archived response required");
      const frame = { entry: "private_source_comparison", context: { workspace_id: WS, run_id: "archived-run",
        session_id: "archived-session", agent_target: "bench-runner" }, request: { ...request, ...(previous === undefined ? {} : { continuation: previous }) },
        response, first_exposure: recordSourceSemanticLibraryFirstExposure(response, exposure, previous) };
      previous = response.index.continuation ?? undefined;
      return frame;
    });
    const capture = JSON.parse(JSON.stringify({ contract: "source-semantic-private-library-capture-v1", profile,
      max_pages: 2, pages, stop: "requested_page_bound" }));
    const options = { workspace_id: WS, run_id: "archived-run", as_of: CLOCK, request, profile,
      verifySources: (response: Extract<import("@do-soul/alaya-protocol").SourceSemanticComparisonResponse, { operation: "recall" }>) =>
        admitDeliveredSources({ workspace_id: WS }, response, sourceLookupStores(fixture.database),
          new SqliteSourceHintReader(fixture.database.connection), ["project"], []) };
    expect(admitPrivateSourceLibraryCapture(capture, options).pages.map(page => page.records.length)).toEqual([5, 5]);
    const mixed = structuredClone(capture); mixed.pages[0].response.index.result_version = "source-semantic-library-v6";
    expect(() => admitPrivateSourceLibraryCapture(mixed, options)).toThrow();
    expect(() => admitPrivateSourceLibraryCapture(capture, { ...options, run_id: "fabricated" })).toThrow(/bound context/);
    expect(() => admitPrivateSourceLibraryCapture(capture, { ...options, verifySources: () => [] })).toThrow(/sealed current source/);
    expect(fixture.prepareQuery).not.toHaveBeenCalled();
  });
});
