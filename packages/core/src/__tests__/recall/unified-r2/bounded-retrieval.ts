import { QueryEmbeddingEngine } from "../../../embedding-recall/query-embedding-engine.js";
import { scoreEmbeddingPoolCandidates } from "../../../embedding-recall/pool-scoring.js";
import type { EmbeddingProviderPort } from "../../../embedding-recall/types.js";
import type { SqliteMemoryRecallReader, SqliteRelationRecallReader } from "@do-soul/alaya-storage";
import { relationMatchesTemporal } from "../../../recall/query/recall-relation-query.js";
import type { CapturedQuery } from "../../../recall/decision/budget-aware-q/capture.js";
import type { FamilyProbeResult, TypedSupportEdge, GovernedContradiction } from "../../../recall/decision/budget-aware-q/types.js";
import type { createRecallEmbeddingRealStorage } from "../../shared/real-sqlite.test-support.js";
import { RUN, WS } from "./ids.js";

export interface ReadyArtifactReader {
  searchReadyObserved(workspaceId: string, query: string, limit: number): {
    rows: readonly { objectId: string; sourceRevision: string; projectionText: string }[];
    rowsRead: number; bytesRead: number; nativeVisits: number; nativeBytes: number; truncated: boolean;
  };
}

export interface RetrievalCounters {
  row_visits: number;
  raw_bytes: number;
  source_reads: number;
  source_revision_rows: number;
  assertion_rows: number;
  query_embed_count: number;
  native_lexical_visits: number;
  native_lexical_bytes: number;
  native_assertion_visits: number;
  native_assertion_bytes: number;
  native_artifact_visits: number;
  native_artifact_bytes: number;
  artifact_validation_utf8_bytes: number;
  embedding_id_json_bytes: number;
  embedding_id_metadata_utf8_bytes: number;
  embedding_vector_payload_bytes: number;
}

export async function retrieveSources(input: {
  captured: CapturedQuery;
  storage: Awaited<ReturnType<typeof createRecallEmbeddingRealStorage>>;
  memoryReader: SqliteMemoryRecallReader;
  recallReader: SqliteRelationRecallReader;
  embeddingProvider?: EmbeddingProviderPort;
  artifactReader?: ReadyArtifactReader;
  counters: RetrievalCounters;
}) {
  const { captured, storage, memoryReader, recallReader, embeddingProvider, artifactReader, counters } = input;
    const probes: FamilyProbeResult[] = [];
    const compiled = captured.probes;
    const lexicalQuery = compiled.lexical_terms.length > 0
      ? compiled.lexical_terms.join(" ")
      : captured.spec.text;
    let remaining = captured.spec.rBase;
    let extensionRemaining = captured.spec.rExtension;
    let rawTruncated = false;
    const sourceCache = new Map<string, ReturnType<SqliteMemoryRecallReader["source"]>["row"]>();
    const account = (rows: number, bytes: number, chargedRows = rows) => {
      remaining -= chargedRows; counters.row_visits += rows; counters.raw_bytes += bytes;
    };
    const loadSource = async (id: string, extension = false) => {
      if (sourceCache.has(id)) return sourceCache.get(id) ?? null;
      if ((extension ? extensionRemaining : remaining) < 2) { rawTruncated = true; return null; }
      // Scoped primary-key hydration is charged even when the source disappeared.
      const source = memoryReader.source(WS, id);
      counters.source_reads += source.sourceRowsRead; counters.source_revision_rows += source.revisionRowsRead;
      if (extension) { extensionRemaining -= 2; counters.row_visits += source.rowsRead; counters.raw_bytes += source.bytesRead; }
      else account(source.rowsRead, source.bytesRead, 2);
      rawTruncated ||= source.unavailable;
      sourceCache.set(id, source.row); return source.row;
    };
    const edges: TypedSupportEdge[] = [];
    const inactiveResults = new Set<string>();
    const contradictions: GovernedContradiction[] = [];
    const query = captured.spec.relationQuery!;
    const applyObservations = async (observations: ReturnType<typeof recallReader.decode>) => {
      for (const observation of observations) {
        const row = await loadSource(observation.resultObjectId);
        if (!row || row.lifecycle_state !== "active" || row.retention_state === "tombstoned" || !observation.evidenceRefs.length ||
            !observation.evidenceRefs.every((id) => row.evidence_refs.includes(id))) continue;
        const resolved = observation.resolvedAt !== null && Date.parse(observation.resolvedAt) <= Date.parse(captured.spec.asOf);
        if (resolved && observation.resolutionKind === "contradicted") {
          contradictions.push({ assertionId: observation.assertionId, sourceObjectId: observation.resultObjectId,
            evidenceRefs: observation.evidenceRefs, resolvedAt: observation.resolvedAt! });
          continue;
        }
        if (resolved || !relationMatchesTemporal(observation.validity, query.temporal)) {
          inactiveResults.add(observation.resultObjectId); continue;
        }
        edges.push({ ...observation, assignmentKey: `owner:${query.subject ?? observation.sourceObjectId.toLowerCase()}` });
      }
    };
    const typedReady = captured.spec.familyCaps.typed_relation === "ready" && (query.subject !== null || captured.spec.exactAggregate);
    const rawLimit = Math.min(512, Math.floor(remaining / 3));
    const lexicalReady = captured.spec.familyCaps.lexical === "ready";
    const nativeLimit = typedReady ? Math.ceil(rawLimit / 2) : rawLimit;
    const lexical = lexicalReady ? memoryReader.lexical(WS, lexicalQuery, rawLimit, nativeLimit) : null;
    if (lexical) {
      account(lexical.rowsRead, lexical.bytesRead, lexical.nativeVisits);
      counters.native_lexical_visits += lexical.nativeVisits; counters.native_lexical_bytes += lexical.nativeBytes;
      rawTruncated ||= lexical.truncated;
    }
    const lexicalIds = lexical?.ids ?? [];
    if (typedReady) {
      const remainingRaw = rawLimit - (lexical?.nativeVisits ?? 0);
      const observed = recallReader.read(WS, query.subject, "owns", remainingRaw);
      account(observed.rowsRead, observed.bytesRead, observed.nativeVisits); counters.assertion_rows += observed.rowsRead;
      counters.native_assertion_visits += observed.nativeVisits; counters.native_assertion_bytes += observed.nativeBytes;
      rawTruncated ||= observed.truncated;
      await applyObservations(observed.observations);
    }
    for (const id of lexicalIds) await loadSource(id);
    if (typedReady && query.wantsChannel) {
      for (const endpoint of new Set(edges.map((edge) => edge.targetObjectId))) {
        const page = recallReader.read(WS, endpoint, "escalation_channel", Math.min(512, Math.floor(remaining / 3)));
        account(page.rowsRead, page.bytesRead, page.nativeVisits); counters.assertion_rows += page.rowsRead;
        counters.native_assertion_visits += page.nativeVisits; counters.native_assertion_bytes += page.nativeBytes;
        rawTruncated ||= page.truncated; await applyObservations(page.observations);
      }
    }
    if (typedReady) probes.push({ family: "typed_relation", probeId: "assertions",
      hits: [...new Set([...edges.map((edge) => edge.resultObjectId), ...contradictions.map((row) => row.sourceObjectId)])].sort().map((id, index) => ({ id, rank: index + 1 })) });
    if (captured.spec.familyCaps.lexical === "ready") probes.push({ family: "lexical", probeId: "fts",
      hits: lexicalIds.map((id, index) => ({ id, rank: index + 1 })) });
    if (artifactReader && captured.spec.familyCaps.lexical === "ready" && remaining >= 7) {
      const limit = Math.min(512, Math.floor(remaining / 7));
      const observed = artifactReader.searchReadyObserved(WS, captured.spec.text, limit);
      const projections = observed.rows;
      account(observed.rowsRead, 0);
      counters.artifact_validation_utf8_bytes += observed.bytesRead;
      counters.native_artifact_visits += observed.nativeVisits; counters.native_artifact_bytes += observed.nativeBytes;
      rawTruncated ||= observed.truncated;
      probes.push({ family: "lexical", probeId: "ready-artifact",
        hits: projections.map((row, index) => ({ id: row.objectId, rank: index + 1 })) });
      for (const row of projections) await loadSource(row.objectId);
    }
    if (captured.spec.familyCaps.embedding === "ready" && embeddingProvider && captured.spec.nExtension > 0 && extensionRemaining >= 4) {
      const profile = { maxRows: Math.min(128, Math.floor(extensionRemaining / 4)), maxMetadataUtf8Bytes: 1024,
        providerKind: embeddingProvider.providerKind, modelId: embeddingProvider.modelId, schemaVersion: embeddingProvider.schemaVersion };
      const discovery = await storage.memoryEmbeddingRepo.listBoundedIdsByWorkspace(WS, profile);
      const ids = discovery.objectIds;
      extensionRemaining -= discovery.rowVisits;
      counters.row_visits += discovery.rowVisits; counters.embedding_id_metadata_utf8_bytes += discovery.metadataUtf8Bytes;
      counters.embedding_id_json_bytes += Buffer.byteLength(JSON.stringify(ids), "utf8");
      rawTruncated ||= discovery.truncated;
      const vectorReader = Object.create(storage.memoryEmbeddingRepo) as typeof storage.memoryEmbeddingRepo;
      vectorReader.listByObjectIds = async (workspaceId, objectIds) => {
        const observed = await storage.memoryEmbeddingRepo.listBoundedByObjectIds(workspaceId, objectIds, {
          ...profile, maxRows: Math.min(profile.maxRows, extensionRemaining), maxObjectIds: profile.maxRows,
          expectedDimensions: 384, maxVectorBytes: 1536 });
        extensionRemaining -= observed.rowVisits; counters.row_visits += observed.rowVisits;
        counters.embedding_vector_payload_bytes += observed.vectorBytes + observed.metadataUtf8Bytes;
        rawTruncated ||= observed.truncated;
        return observed.records;
      };
      const queryProvider: EmbeddingProviderPort = {
        providerKind: embeddingProvider.providerKind, modelId: embeddingProvider.modelId,
        schemaVersion: embeddingProvider.schemaVersion, isAvailable: embeddingProvider.isAvailable,
        embedTexts: (texts, options) => { counters.query_embed_count += 1; return embeddingProvider.embedTexts(texts, options); }
      };
      const queryEngine = new QueryEmbeddingEngine({ provider: queryProvider, generateQueryId: () => "local-query",
        queryTimeoutMs: 30000, queryEmbeddingCacheSize: 0 });
      const scores = await scoreEmbeddingPoolCandidates({ workspaceId: WS, runId: RUN,
        queryText: captured.spec.text, objectIds: ids, embeddingRepo: vectorReader,
        provider: queryProvider, queryEngine, queryTimeoutMs: 30000,
        warn: (message) => { throw new Error(message); } });
      const ranked = [...scores].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
      probes.push({ family: "embedding", probeId: "local-model", hits: ranked.map(([id], index) => ({ id, rank: index + 1 })) });
      for (const [id] of ranked) { await loadSource(id, true); }
    }
    return { probes, edges, inactiveResults, contradictions, query, sourceCache, rawTruncated };
}
