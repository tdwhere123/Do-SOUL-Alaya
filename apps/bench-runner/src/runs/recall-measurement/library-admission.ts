import BetterSqlite3 from "better-sqlite3";
import { StorageDatabase, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { admitSourceSemanticQuery, authorizedScopesFromAdmission, authorizeSemanticScope, fieldContractSha256,
  hydrateUtf8Chunk, preparedDeliveryId, proofForLibraryEntry, resolveCurrentSource, sourceSemanticQueryStatus,
  semanticInterpretationEvidenceId, sourceSemanticAccessInputIdentity, sourceSemanticLibraryQueryIdentity,
  sourceSemanticLibraryRequestIdentity, verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { AlayaError, canonicalJson, SoulInterpretationRequestSchema, sourceSemanticAccessPhases, sourceEvidenceRootTarget, sourceRecallTarget,
  type MemorySearchResult, type SourceEvidenceTarget, type SourceSemanticLibrarySlotQualifier,
  type SourceRecordIdentity, type SoulInterpretationResponse, type SourceSemanticComparisonResponse } from "@do-soul/alaya-protocol";
import { sourceLookupStores } from "../snapshot/source-records/publish.js";
import type { SemanticChainConfig, SemanticChainPlan } from "./contract.js";
import type { discoverSemanticChainQuery } from "./prepare.js";
import type { semanticChainQueryCorrespondences } from "./inputs.js";

type Query = Exclude<SemanticChainPlan["queries"][number], { status: "blocked" }>;
type Recall = Extract<SoulInterpretationResponse, { operation: "recall" }>;
type Correspondences = ReturnType<typeof semanticChainQueryCorrespondences>["ready"];

/** One frozen request constructor for native replay, capture and archive request admission. */
export function semanticChainLibraryRecallRequest(config: SemanticChainConfig, query: Query, ready: Correspondences, queryHandle?: string) {
  return SoulInterpretationRequestSchema.parse({ operation: "recall", original_query: query.original_query,
    ...(query.status === "ready" ? { query_semantics: query.query_semantics }
      : query.query_semantics_unavailable === "absent" ? {} : { query_semantics_unavailable: query.query_semantics_unavailable }),
    query_handle: queryHandle, semantic_correspondences: ready, accepts_unreviewed_conditional_results: true, budget: config.budget,
    output_byte_limit: config.output_byte_limit, authorized_scopes: config.authorized_scopes, access_policy: config.access_policy });
}

/** The connection-local pool ID and elapsed preparation time are not cross-session identities. */
export function sameSealedSnapshotObservation(expected: Awaited<ReturnType<typeof discoverSemanticChainQuery>>["discovery"],
  actual: Awaited<ReturnType<typeof discoverSemanticChainQuery>>["discovery"]): boolean {
  const comparable = (value: typeof actual) => ({ descriptors: value.descriptors,
    access: value.discovery_trace.map(({ access }) => {
      const { pool_id: _connectionPoolId, phases: _phases, ...observation } = access;
      const { preparation, ...otherPhases } = sourceSemanticAccessPhases(access);
      return { ...observation, ...otherPhases, preparation: { ...preparation, elapsed_ms: undefined } };
    }) });
  return canonicalJson(comparable(expected)) === canonicalJson(comparable(actual));
}

/** Initial and continued pages bind the same resolved request and prepared pool, not a new query. */
export function admitSemanticChainLibraryBinding(config: SemanticChainConfig, query: Query, response: Recall,
  selected: Correspondences, trace: Query["discovery_trace"] | null | undefined): readonly string[] | null {
  const scopes = authorizedScopesFromAdmission(config.authorized_scopes).authorized_scopes;
  if (scopes === undefined || response.index === undefined) throw new AlayaError("CONFLICT", "native delivery requires explicit scope and index admission");
  const querySemantics = query.status === "ready" ? query.query_semantics : undefined;
  const queryStatus = sourceSemanticQueryStatus(admitSourceSemanticQuery(querySemantics, query.original_query),
    query.status === "raw_ready" && query.query_semantics_unavailable !== "absent"
      ? query.query_semantics_unavailable : undefined);
  const expectedIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: config.workspace_id, as_of: config.interpretation_clock,
    authorized_scopes: scopes, original_query: query.original_query, query_semantics: querySemantics,
    query_semantics_status: queryStatus, semantic_correspondences: selected, budget: config.budget,
    output_byte_limit: config.output_byte_limit, access_policy: config.access_policy });
  if (response.request_identity !== expectedIdentity || response.index.query_id !== sourceSemanticLibraryQueryIdentity(query.original_query)
    || canonicalJson(response.query_semantics_status) !== canonicalJson(queryStatus)
    || response.index.as_of !== config.interpretation_clock || canonicalJson(response.request_budget) !== canonicalJson(config.budget)) {
    throw new AlayaError("CONFLICT", "native delivery belongs to another frozen request");
  }
  if (response.delivery_id !== preparedDeliveryId(expectedIdentity, response.index)) {
    throw new AlayaError("CONFLICT", "native delivery ID does not bind its frozen request and index");
  }
  const access = response.discovery?.access;
  if (trace == null || trace.length === 0 || !sameSealedSnapshotObservation(query, { ...query, discovery_trace: trace })
    || access === undefined || access.pool_id !== trace.at(-1)!.access.pool_id || access.policy !== config.access_policy
    || access.input_id !== sourceSemanticAccessInputIdentity({ original_query: query.original_query, query_semantics: querySemantics,
      budget: config.budget, policy: config.access_policy, contract: "source-semantic-access-v2",
      ...(config.source_preview_extents === undefined ? {} : { source_preview_extents: config.source_preview_extents })
    })) throw new AlayaError("CONFLICT", "native delivery does not bind the prepared access pool");
  if (query.status === "raw_ready" && (response.proofs?.length ?? 0) > 0) {
    throw new AlayaError("CONFLICT", "unavailable query semantics cannot deliver a semantic proof");
  }
  return scopes;
}

/** Reuse the sealed-source/proof admission for new frozen captures, without evaluating labels. */
export function admitSealedSemanticChainLibraryDelivery(config: SemanticChainConfig, query: Query, response: Recall,
  correspondences: Correspondences, trace: Query["discovery_trace"] | null | undefined): SourceRecordIdentity[] {
  const scopes = admitSemanticChainLibraryBinding(config, query, response, correspondences, trace);
  const connection = new BetterSqlite3(config.snapshot_path, { readonly: true, fileMustExist: true });
  try {
    connection.pragma("query_only = ON");
    return admitDeliveredSources(config, response, sourceLookupStores(new StorageDatabase(config.snapshot_path, connection)),
      new SqliteSourceHintReader(connection), scopes, correspondences);
  } finally { connection.close(); }
}

export function admitDeliveredSources(config: Pick<SemanticChainConfig, "workspace_id">,
  response: Recall | Extract<SourceSemanticComparisonResponse, { operation: "recall" }>,
  stores: ReturnType<typeof sourceLookupStores>, reader: SqliteSourceHintReader, scopes: readonly string[] | null,
  correspondences: Correspondences): SourceRecordIdentity[] {
  const records: SourceRecordIdentity[] = [];
  if (response.index === undefined || response.results?.length !== response.index.entries.length) {
    throw new AlayaError("CONFLICT", "native delivery has no complete emitted source page");
  }
  for (const [position, entry] of response.index.entries.entries()) {
    const target = entry.target;
    if (target.kind !== "source_evidence" || target.workspace_id !== config.workspace_id) throw new AlayaError("CONFLICT", "native source workspace changed");
    const retained = stores.getStoredRecord(config.workspace_id, target.root_id);
    if (retained === null) throw new AlayaError("CONFLICT", "delivered source is unavailable in sealed snapshot");
    const current = resolveCurrentSource(stores, config.workspace_id, { artifact_key: retained.record.source_id,
      source_corpus_digest: target.content_digest.replace(/^sha256:/u, "") }, fieldContractSha256);
    authorizeSemanticScope(current.record.scope_class, scopes);
    if (canonicalJson(sourceEvidenceRootTarget(target)) !== canonicalJson(sourceRecallTarget({ workspace_id: current.record.workspace_id,
      root_kind: "source_record", root_id: current.record.identity, source_version: current.record.source_version,
      content_digest: current.record.content_digest, evidence_object_id: current.record.evidence_object_id }))) {
      throw new AlayaError("CONFLICT", "delivered source identity differs from current sealed source");
    }
    const qualifiers = response.slot_qualifiers?.filter(qualifier => qualifier.index === position) ?? [];
    for (const qualifier of qualifiers.length === 0 ? [undefined] : qualifiers) {
      admitEmittedSourcePreview(target.span, response.results[position]!, qualifier,
        target, current.content_bytes, proofForLibraryEntry(entry, response.proofs ?? []) !== undefined);
    }
    records.push(current.record);
  }
  for (const proof of response.proofs ?? []) {
    if (!correspondences.some((value) => canonicalJson(value) === canonicalJson(proof.semantic_correspondence))) {
      throw new AlayaError("CONFLICT", "delivered proof lacks its retained semantic correspondence");
    }
    const capsule = reader.readBoundInterpretationCompatible(config.workspace_id,
      [semanticInterpretationEvidenceId(proof.source_interpretation_id!, fieldContractSha256, config.workspace_id),
        semanticInterpretationEvidenceId(proof.source_interpretation_id!, fieldContractSha256)], 1_000_000);
    if (capsule.status !== "complete" || capsule.gist === null) throw new AlayaError("CONFLICT", "delivered interpretation is unavailable in sealed snapshot");
    const checked = verifyPublishedSourceSemanticInterpretation({ stores, sha256: fieldContractSha256 }, JSON.parse(capsule.gist), config.workspace_id);
    if (checked.bound.interpretation_id !== proof.source_interpretation_id) throw new AlayaError("CONFLICT", "delivered interpretation differs from its proof identity");
    authorizeSemanticScope(checked.stored.record.scope_class, scopes);
    records.push(checked.stored.record);
  }
  return [...new Map(records.map((record) => [record.identity, record])).values()];
}

export function admitEmittedSourcePreview(span: SourceEvidenceTarget["span"], result: MemorySearchResult,
  qualifier: SourceSemanticLibrarySlotQualifier | undefined, target: SourceEvidenceTarget, source: string,
  requiresCompleteSupport: boolean): void {
  if (canonicalJson(result.target) !== canonicalJson(target)) {
    throw new AlayaError("CONFLICT", "emitted source target differs from delivered index");
  }
  if (span?.retained_extent !== "body") throw new AlayaError("CONFLICT", "emitted source has no bound body span");
  const full = hydrateUtf8Chunk(source, { offset: span.content_start, byteLimit: span.content_end - span.content_start });
  if (full.status !== "chunk" || full.end_offset !== span.content_end) {
    throw new AlayaError("CONFLICT", "emitted source span is not a UTF-8 slice of sealed source");
  }
  if (requiresCompleteSupport && (qualifier?.evidence_kind !== "semantic_proof"
    || qualifier.payload_support !== "available" || !result.budget_state.within_budget)) {
    throw new AlayaError("CONFLICT", "available proof support requires its complete emitted source preview");
  }
  if (result.content_preview === "[payload omitted]" && !result.budget_state.within_budget) return;
  const emitted = result.content_preview === "[empty source]" && span.content_end === span.content_start
    ? "" : result.content_preview;
  const byteLength = Buffer.byteLength(emitted, "utf8");
  if (result.budget_state.within_budget && emitted !== full.text) {
    throw new AlayaError("CONFLICT", "emitted source preview differs from sealed source span");
  }
  if (byteLength > span.content_end - span.content_start) {
    throw new AlayaError("CONFLICT", "emitted source preview exceeds sealed source span");
  }
  const chunk = hydrateUtf8Chunk(source, { offset: span.content_start, byteLimit: byteLength });
  if (chunk.status !== "chunk" || chunk.end_offset !== span.content_start + byteLength || chunk.text !== emitted) {
    throw new AlayaError("CONFLICT", "emitted source preview differs from sealed source span");
  }
}
