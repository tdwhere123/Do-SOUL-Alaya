import { join } from "node:path";
import { SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  SourceSemanticWorkerResultSchema, indexEntryCacheKey, sourceSemanticExecution,
  type SourceRecordIdentity, type SoulInterpretationResponse } from "@do-soul/alaya-protocol";
import { assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResponse, preparedDeliveryId, projectSourceDisclosure,
  sourceSemanticLibrarySourceEntry, sourceSemanticLibraryQueryIdentity, sourceSemanticLibraryRequestIdentity,
  SOURCE_SEMANTIC_LIBRARY_ORDER } from "@do-soul/alaya-core";
import { FirstExposureSession } from "../../../runs/measurement/first-exposure-session.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import { chainIdentity, writeChainArtifact, type SemanticChainPlan } from "../../../runs/recall-measurement/contract.js";
import { inspectSemanticChainReplayTarget } from "../../../runs/recall-measurement/replay.js";
import { semanticChainLibraryRecallRequest } from "../../../runs/recall-measurement/library-admission.js";

type Recall = Extract<SoulInterpretationResponse, { operation: "recall" }>;
type Source = Readonly<{ record: SourceRecordIdentity; text: string }>;

/** Artificial offline v6 pages built by the retained compatibility encoder from independently
 * published sources. Not a live selector, daemon result, receipt alias, or rebind of old evidence. */
export function archivedLibraryPages(plan: SemanticChainPlan, sources: readonly Source[], sessionId: string) {
  const query = plan.queries[0]!;
  if (query.status !== "raw_ready") throw new Error("archived source-only fixture requires unavailable query semantics");
  const config = plan.config;
  const access = query.discovery_trace.at(-1)!.access;
  const queryStatus = query.discovery_trace.at(-1)!.query_semantics_status;
  if (queryStatus === undefined) throw new Error("prepared query status required");
  const requestIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: config.workspace_id,
    as_of: config.interpretation_clock, authorized_scopes: ["project"], original_query: query.original_query,
    query_semantics_status: queryStatus, semantic_correspondences: [], budget: config.budget,
    output_byte_limit: config.output_byte_limit, access_policy: config.access_policy });
  const entries = sources.map(({ record, text }) => {
    const entry = sourceSemanticLibrarySourceEntry({ workspaceId: record.workspace_id, root_id: record.identity,
      source_version: record.source_version, content_digest: record.content_digest,
      evidence_object_id: record.evidence_object_id, hypothesis_id: "archived-source-only" });
    return { ...entry, target: { ...entry.target, span: { content_start: 0, content_end: Buffer.byteLength(text),
      retained_extent: "body" as const, content_complete: true, original_complete: true } } };
  });
  const pages = [0, 5].map(offset => {
    const { index } = assembleSourceSemanticLibraryIndex({ query_id: sourceSemanticLibraryQueryIdentity(query.original_query),
      snapshot_id: `sha256:${config.snapshot_sha256}`, interpretation_id: sessionId, as_of: config.interpretation_clock,
      proof_groups: [], source_entries: entries, offset, truncated: false, open_residuals: false,
      authorized_scopes: ["project"], expires_at: "2099-01-01T00:00:00.000Z" });
    const previews = Object.fromEntries(index.entries.map(entry => [indexEntryCacheKey(entry),
      sources.find(source => entry.target.kind === "source_evidence" && source.record.identity === entry.target.root_id)!.text]));
    const worker = SourceSemanticWorkerResultSchema.parse({ kind: "recall", protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
      request_identity: requestIdentity, delivery_id: preparedDeliveryId(requestIdentity, index),
      request_budget: config.budget, query_semantics_status: queryStatus, index, previews,
      total_count: index.entries.length, page_purpose: "membership", order: SOURCE_SEMANTIC_LIBRARY_ORDER,
      source_disclosures: Object.fromEntries(index.entries.map(entry => [indexEntryCacheKey(entry),
        projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: config.interpretation_clock,
          proof_use: "source_only" })])),
      slot_qualifiers: index.entries.map((_, index) => ({ index, evidence_kind: "source_evidence" })),
      discovery: { access, eligible_source_count: sources.length, visited_source_pages: 1,
        visited_source_interpretation_pages: 1, visited_source_interpretation_descriptors: 0, candidate_prefix: [],
        examined_source_interpretation_ids: [], unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0,
        examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, open_residuals: false, truncated: false },
      coverage: { discovery: "complete", source_interpretation: "unexercised", query_semantics: "unexercised",
        semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete" },
      work: { native_work: 7, native_bytes: 11, logical_memory_bytes: 13, rss_bytes: 17 }, execution: sourceSemanticExecution() });
    if (worker.kind !== "recall") throw new Error("archived recall required");
    const response = encodeSourceSemanticLibraryResponse(worker);
    if (response.operation !== "recall") throw new Error("archived recall response required");
    return response;
  });
  return { initial: pages[0]!, continued: pages[1]! };
}

/** Writes a new artificial archive through the existing immutable writer and exposure owner.
 * The optional hook exercises the real second-envelope filesystem boundary, not a fake success. */
export function archiveLibraryCapture(input: { chainRoot: string; output: string; plan: SemanticChainPlan;
  initial: Recall; continued?: Recall; maxPages: 1 | 2; beforeSecondEnvelope?: () => void;
  continuationExposure?: "present" | "null" }) {
  const { chainRoot, output, plan, initial, continued, maxPages } = input;
  const query = plan.queries[0]!;
  if (query.status === "blocked") throw new Error("prepared query required");
  const material = { contract: "source-semantic-library-capture-v1", mode: "library", max_pages: maxPages,
    execution_observation: "disabled", output_root: output, plan_identity: chainIdentity(plan),
    correspondence_identity: inspectSemanticChainReplayTarget(chainRoot, "retained").identity, arm: "retained" };
  const identity = chainIdentity(material), directory = join(output, query.query_key);
  writeChainArtifact(join(output, "capture-owner.json"), { ...material, identity });
  const request = { name: "soul.interpretation", arguments: semanticChainLibraryRecallRequest(plan.config, query, [], "archived-query") };
  const session = new FirstExposureSession();
  const exposure = recordSourceSemanticLibraryFirstExposure(initial, session);
  writeChainArtifact(join(directory, "initial.json.reserved"), { replay_identity: identity, query_key: query.query_key });
  const frame = (page: number, request: { name: string; arguments: unknown }, response: Recall) => {
    writeChainArtifact(join(directory, `page-${page}.reserved`), { capture_identity: identity, query_key: query.query_key,
      page, request_identity: chainIdentity(request) });
    writeChainArtifact(join(directory, `page-${page}.request.json`), request);
    if (page === 2) input.beforeSecondEnvelope?.();
    writeChainArtifact(join(directory, `page-${page}.mcp.json`), { request, response: {
      content: [{ type: "text", text: JSON.stringify({ ok: true, tool_name: request.name, output: response }) }],
      structuredContent: { ok: true, output: response } } });
  };
  frame(1, request, initial);
  writeChainArtifact(join(directory, "initial.json"), { query_key: query.query_key, status: "replayed", response: initial,
    first_exposure: exposure, correspondence_outcomes: [], preparation_trace: query.discovery_trace,
    preparation_elapsed_ms: 2, native_elapsed_ms: 5 });
  if (continued !== undefined) {
    frame(2, { ...request, arguments: { ...request.arguments, continuation: initial.index!.continuation } }, continued);
    writeChainArtifact(join(directory, "page-2.native.json"), { response: continued,
      first_exposure: input.continuationExposure === "null" ? null
        : recordSourceSemanticLibraryFirstExposure(continued, session, initial.index!.continuation!) });
  }
  writeChainArtifact(join(directory, "stop.json"), { status: "captured", reason: "requested_page_bound",
    page2: continued === undefined ? "not_requested" : "observed" });
  writeChainArtifact(join(output, "capture.json"), { contract: material.contract, identity, query_keys: [query.query_key] });
  return { directory, initial, exposure };
}
