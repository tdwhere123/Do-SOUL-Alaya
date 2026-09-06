import { QueryEmbeddingEngine } from "../../embedding-recall/query-embedding-engine.js";
import { scoreEmbeddingPoolCandidates } from "../../embedding-recall/pool-scoring.js";
import type { EmbeddingProviderPort } from "../../embedding-recall/types.js";
import { relationMatchesTemporal } from "../query/recall-relation-query.js";
import type { CapturedQuery } from "../decision/budget-aware-q/capture.js";
import type {
  FamilyProbeResult, TypedSupportEdge, GovernedContradiction
} from "../decision/budget-aware-q/types.js";
import type {
  IndexedEmbeddingReadPort, IndexedMemoryReadPort, IndexedRelationReadPort, IndexedSourceRow,
  ReadyArtifactReader, RecallAssertionObservation, RetrievalCounters
} from "./indexed-family-ports.js";

export type {
  IndexedEmbeddingReadPort, IndexedMemoryReadPort, IndexedRelationReadPort, ReadyArtifactReader,
  RetrievalCounters
} from "./indexed-family-ports.js";

export async function retrieveIndexedFamilies(input: {
  readonly captured: CapturedQuery;
  readonly memoryReader: IndexedMemoryReadPort;
  readonly recallReader: IndexedRelationReadPort;
  readonly runId?: string | null;
  readonly embeddingProvider?: EmbeddingProviderPort;
  readonly embeddingRepo?: IndexedEmbeddingReadPort;
  readonly artifactReader?: ReadyArtifactReader;
  readonly counters: RetrievalCounters;
}) {
  const ctx = createReadContext(input);
  ctx.rawLimit = Math.min(512, Math.floor(ctx.remaining / 3));
  const probes: FamilyProbeResult[] = [];
  const lexicalIds = readLexicalFamily(ctx, probes);
  await readTypedRelationFamily(ctx, probes);
  for (const id of lexicalIds) await ctx.loadSource(id);
  await readReadyArtifactFamily(ctx, probes);
  await readEmbeddingFamily(ctx, probes);
  return {
    probes, edges: ctx.edges, inactiveResults: ctx.inactiveResults,
    contradictions: ctx.contradictions, query: input.captured.spec.relationQuery!,
    sourceCache: ctx.sourceCache, rawTruncated: ctx.rawTruncated, usedTierScan: false
  };
}

export const retrieveSources = retrieveIndexedFamilies;

function createReadContext(input: Parameters<typeof retrieveIndexedFamilies>[0]): FamilyReadContext {
  const sourceCache = new Map<string, IndexedSourceRow | null>();
  const ctx: FamilyReadContext = {
    ...input, workspaceId: input.captured.spec.workspaceId,
    remaining: input.captured.spec.rBase, extensionRemaining: input.captured.spec.rExtension,
    rawTruncated: false, sourceCache, edges: [], inactiveResults: new Set(), contradictions: [],
    loadSource: async (id, extension = false) => loadSource(ctx, id, extension)
  };
  return ctx;
}

async function loadSource(
  ctx: FamilyReadContext, id: string, extension: boolean
): Promise<IndexedSourceRow | null> {
  if (ctx.sourceCache.has(id)) return ctx.sourceCache.get(id) ?? null;
  if ((extension ? ctx.extensionRemaining : ctx.remaining) < 2) {
    ctx.rawTruncated = true;
    return null;
  }
  const source = ctx.memoryReader.source(ctx.workspaceId, id);
  ctx.counters.source_reads += source.sourceRowsRead;
  ctx.counters.source_revision_rows += source.revisionRowsRead;
  if (extension) {
    ctx.extensionRemaining -= 2;
    ctx.counters.row_visits += source.rowsRead;
    ctx.counters.raw_bytes += source.bytesRead;
  } else {
    ctx.remaining -= 2;
    ctx.counters.row_visits += source.rowsRead;
    ctx.counters.raw_bytes += source.bytesRead;
  }
  ctx.rawTruncated ||= source.unavailable;
  ctx.sourceCache.set(id, source.row);
  return source.row;
}

function readLexicalFamily(ctx: FamilyReadContext, probes: FamilyProbeResult[]): readonly string[] {
  if (ctx.captured.spec.familyCaps.lexical !== "ready") return [];
  const compiled = ctx.captured.probes;
  const lexicalQuery = compiled.lexical_terms.length > 0
    ? compiled.lexical_terms.join(" ") : ctx.captured.spec.text;
  const rawLimit = ctx.rawLimit ?? Math.min(512, Math.floor(ctx.remaining / 3));
  const nativeLimit = isTypedReady(ctx.captured) ? Math.ceil(rawLimit / 2) : rawLimit;
  const lexical = ctx.memoryReader.lexical(ctx.workspaceId, lexicalQuery, rawLimit, nativeLimit);
  ctx.remaining -= lexical.nativeVisits;
  ctx.counters.row_visits += lexical.rowsRead;
  ctx.counters.raw_bytes += lexical.bytesRead;
  ctx.counters.native_lexical_visits += lexical.nativeVisits;
  ctx.counters.native_lexical_bytes += lexical.nativeBytes;
  ctx.rawTruncated ||= lexical.truncated;
  probes.push({ family: "lexical", probeId: "fts",
    hits: lexical.ids.map((id, index) => ({ id, rank: index + 1 })) });
  ctx.lexicalNativeVisits = lexical.nativeVisits;
  return lexical.ids;
}

async function readTypedRelationFamily(ctx: FamilyReadContext, probes: FamilyProbeResult[]): Promise<void> {
  const query = ctx.captured.spec.relationQuery!;
  if (!isTypedReady(ctx.captured)) return;
  const predicates = [...new Set(ctx.captured.spec.obligations.flatMap((obligation) => obligation.requiredPredicates))];
  if (predicates.length === 0) return;
  const observed = ctx.recallReader.read(ctx.workspaceId, query.subject, predicates[0]!,
    (ctx.rawLimit ?? 0) - (ctx.lexicalNativeVisits ?? 0));
  accountAssertionPage(ctx, observed);
  await applyObservations(ctx, observed.observations);
  for (const predicate of predicates.slice(1)) {
    for (const endpoint of new Set(ctx.edges.map((edge) => edge.targetObjectId))) {
      const page = ctx.recallReader.read(ctx.workspaceId, endpoint, predicate,
        Math.min(512, Math.floor(ctx.remaining / 3)));
      accountAssertionPage(ctx, page);
      await applyObservations(ctx, page.observations);
    }
  }
  probes.push({ family: "typed_relation", probeId: "assertions",
    hits: [...new Set([...ctx.edges.map((edge) => edge.resultObjectId),
      ...ctx.contradictions.map((row) => row.sourceObjectId)])].sort()
      .map((id, index) => ({ id, rank: index + 1 })) });
}

async function readReadyArtifactFamily(ctx: FamilyReadContext, probes: FamilyProbeResult[]): Promise<void> {
  if (!ctx.artifactReader || ctx.captured.spec.familyCaps.lexical !== "ready" || ctx.remaining < 7) {
    return;
  }
  const observed = ctx.artifactReader.searchReadyObserved(ctx.workspaceId, ctx.captured.spec.text,
    Math.min(512, Math.floor(ctx.remaining / 7)));
  ctx.remaining -= observed.rowsRead;
  ctx.counters.row_visits += observed.rowsRead;
  ctx.counters.artifact_validation_utf8_bytes += observed.bytesRead;
  ctx.counters.native_artifact_visits += observed.nativeVisits;
  ctx.counters.native_artifact_bytes += observed.nativeBytes;
  ctx.rawTruncated ||= observed.truncated;
  probes.push({ family: "lexical", probeId: "ready-artifact",
    hits: observed.rows.map((row, index) => ({ id: row.objectId, rank: index + 1 })) });
  for (const row of observed.rows) await ctx.loadSource(row.objectId);
}

async function readEmbeddingFamily(ctx: FamilyReadContext, probes: FamilyProbeResult[]): Promise<void> {
  const spec = ctx.captured.spec;
  if (spec.familyCaps.embedding !== "ready" || ctx.embeddingProvider === undefined ||
      ctx.embeddingRepo === undefined || spec.nExtension <= 0 || ctx.extensionRemaining < 4) return;
  const embeddingRepo = ctx.embeddingRepo;
  const provider = ctx.embeddingProvider;
  const profile = {
    maxRows: Math.min(128, Math.floor(ctx.extensionRemaining / 4)), maxMetadataUtf8Bytes: 1024,
    providerKind: provider.providerKind, modelId: provider.modelId, schemaVersion: provider.schemaVersion
  };
  const discovery = await embeddingRepo.listBoundedIdsByWorkspace(ctx.workspaceId, profile);
  ctx.extensionRemaining -= discovery.rowVisits;
  ctx.counters.row_visits += discovery.rowVisits;
  ctx.counters.embedding_id_metadata_utf8_bytes += discovery.metadataUtf8Bytes;
  ctx.counters.embedding_id_json_bytes += Buffer.byteLength(JSON.stringify(discovery.objectIds), "utf8");
  ctx.rawTruncated ||= discovery.truncated;
  const queryProvider = countingProvider(ctx, provider);
  const scores = await scoreEmbeddingPoolCandidates({
    workspaceId: ctx.workspaceId, runId: ctx.runId ?? null, queryText: spec.text,
    objectIds: discovery.objectIds,
    embeddingRepo: {
      listByObjectIds: async (workspaceId, objectIds) => {
        const observed = await embeddingRepo.listBoundedByObjectIds(workspaceId, objectIds, {
          ...profile, maxRows: Math.min(profile.maxRows, ctx.extensionRemaining),
          maxObjectIds: profile.maxRows, expectedDimensions: 384, maxVectorBytes: 1536
        });
        ctx.extensionRemaining -= observed.rowVisits;
        ctx.counters.row_visits += observed.rowVisits;
        ctx.counters.embedding_vector_payload_bytes += observed.vectorBytes + observed.metadataUtf8Bytes;
        ctx.rawTruncated ||= observed.truncated;
        return observed.records;
      }
    },
    provider: queryProvider,
    queryEngine: new QueryEmbeddingEngine({
      provider: queryProvider, generateQueryId: () => "local-query",
      queryTimeoutMs: 30000, queryEmbeddingCacheSize: 0
    }),
    queryTimeoutMs: 30000, warn: (message) => { throw new Error(message); }
  });
  const ranked = [...scores].sort(([left, leftScore], [right, rightScore]) =>
    rightScore - leftScore || left.localeCompare(right));
  probes.push({ family: "embedding", probeId: "local-model",
    hits: ranked.map(([id], index) => ({ id, rank: index + 1 })) });
  for (const [id] of ranked) await ctx.loadSource(id, true);
}

function countingProvider(ctx: FamilyReadContext, provider: EmbeddingProviderPort): EmbeddingProviderPort {
  return {
    providerKind: provider.providerKind, modelId: provider.modelId,
    schemaVersion: provider.schemaVersion, isAvailable: provider.isAvailable,
    embedTexts: (texts, options) => {
      ctx.counters.query_embed_count += 1;
      return provider.embedTexts(texts, options);
    }
  };
}

function accountAssertionPage(
  ctx: FamilyReadContext, page: ReturnType<IndexedRelationReadPort["read"]>
): void {
  ctx.remaining -= page.nativeVisits;
  ctx.counters.row_visits += page.rowsRead;
  ctx.counters.raw_bytes += page.bytesRead;
  ctx.counters.assertion_rows += page.rowsRead;
  ctx.counters.native_assertion_visits += page.nativeVisits;
  ctx.counters.native_assertion_bytes += page.nativeBytes;
  ctx.rawTruncated ||= page.truncated;
}

async function applyObservations(
  ctx: FamilyReadContext, observations: readonly RecallAssertionObservation[]
): Promise<void> {
  const query = ctx.captured.spec.relationQuery!;
  for (const observation of observations) {
    const row = await ctx.loadSource(observation.resultObjectId);
    if (!row || row.lifecycle_state !== "active" || row.retention_state === "tombstoned" ||
        observation.evidenceRefs.length === 0 ||
        !observation.evidenceRefs.every((id) => row.evidence_refs.includes(id))) continue;
    const resolved = observation.resolvedAt !== null &&
      Date.parse(observation.resolvedAt) <= Date.parse(ctx.captured.spec.asOf);
    if (resolved && observation.resolutionKind === "contradicted") {
      ctx.contradictions.push({
        assertionId: observation.assertionId, sourceObjectId: observation.resultObjectId,
        evidenceRefs: observation.evidenceRefs, resolvedAt: observation.resolvedAt!
      });
      continue;
    }
    if (resolved || !relationMatchesTemporal(observation.validity, query.temporal)) {
      ctx.inactiveResults.add(observation.resultObjectId);
      continue;
    }
    ctx.edges.push({
      ...observation,
      assignmentKey: `owner:${query.subject ?? observation.sourceObjectId.toLowerCase()}`
    });
  }
}

function isTypedReady(captured: CapturedQuery): boolean {
  const query = captured.spec.relationQuery!;
  return captured.spec.familyCaps.typed_relation === "ready" &&
    (query.subject !== null || captured.spec.exactAggregate);
}

interface FamilyReadContext {
  readonly captured: CapturedQuery;
  readonly memoryReader: IndexedMemoryReadPort;
  readonly recallReader: IndexedRelationReadPort;
  readonly runId?: string | null;
  readonly embeddingProvider?: EmbeddingProviderPort;
  readonly embeddingRepo?: IndexedEmbeddingReadPort;
  readonly artifactReader?: ReadyArtifactReader;
  readonly counters: RetrievalCounters;
  readonly workspaceId: string;
  remaining: number;
  extensionRemaining: number;
  rawTruncated: boolean;
  readonly sourceCache: Map<string, IndexedSourceRow | null>;
  readonly edges: TypedSupportEdge[];
  readonly inactiveResults: Set<string>;
  readonly contradictions: GovernedContradiction[];
  readonly loadSource: (id: string, extension?: boolean) => Promise<IndexedSourceRow | null>;
  lexicalNativeVisits?: number;
  rawLimit?: number;
}
