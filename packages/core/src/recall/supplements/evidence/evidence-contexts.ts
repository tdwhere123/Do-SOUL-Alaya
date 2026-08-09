import { createHash } from "node:crypto";
import type {
  EvidenceCapsule,
  MemoryEntry,
  OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import {
  VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX,
  buildVerifiedUserAssertionReceiptPreimage,
  readVerifiedUserAssertionSourceHashDigest
} from "@do-soul/alaya-protocol";
import {
  projectVerifiedUserAssertionContext,
  type RecallVerifiedUserAssertionContext
} from "../../query/recall-user-assertion-context.js";
import { createBoundedNonMemoryPreview } from
  "../../coarse-filter/non-memory-preview.js";
import { isDirectRecallEvidence } from
  "../../coarse-filter/evidence/direct-evidence-candidate.js";
import { uniqueStrings } from "../../expansion/path-relations.js";
import {
  errorNameOf,
  toErrorMessage
} from "../../runtime/recall-service-helpers.js";
import type {
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallEvidenceSemanticDocument,
  RecallEvidenceSemanticProjectionReceipt
} from "../../runtime/recall-service-types.js";
import type { RecallQualifiedEvidence } from "../../runtime/recall-service-ports.js";

const MAX_REFS_PER_MEMORY = 8;

export interface RecallEvidenceContexts {
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  readonly evidenceSemanticDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
  readonly verifiedUserAssertionContextsByMemoryId: Readonly<
    Record<string, Readonly<RecallVerifiedUserAssertionContext>>
  >;
  readonly semanticFactorFormationsByEvidenceId: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
}

interface EvidenceRecord {
  readonly evidence: Readonly<EvidenceCapsule>;
}

export async function collectRecallEvidenceContexts(params: Readonly<{
  readonly dependencies: Pick<RecallServiceDependencies, "evidenceSearchPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
}>): Promise<Readonly<RecallEvidenceContexts>> {
  const evidenceSearchPort = params.dependencies.evidenceSearchPort;
  if (evidenceSearchPort?.findByIds === undefined) return emptyEvidenceContexts();
  const gistCandidates = collectRelevantCandidates(
    params.candidates,
    params.coarseEvidenceFtsRanks
  );
  const authorityCandidates = params.candidates.filter(
    (entry) => entry.evidence_refs.length > 0
  );
  const evidenceIds = uniqueStrings([
    ...collectRelevantEvidenceIds(
      gistCandidates,
      params.coarseEvidenceFtsRanksPerRef
    ),
    ...collectAuthorityEvidenceIds(authorityCandidates)
  ]);
  if (evidenceIds.length === 0) return emptyEvidenceContexts();
  try {
    const [capsules, factKeys, semanticFormations] = await Promise.all([
      evidenceSearchPort.findByIds(params.workspaceId, evidenceIds),
      loadQualifiedFactKeys(params, evidenceIds),
      loadQualifiedSemanticFormations(params, evidenceIds)
    ]);
    return buildMemoryEvidenceContexts(
      params.workspaceId,
      gistCandidates,
      authorityCandidates,
      params.coarseEvidenceFtsRanksPerRef,
      capsules,
      factKeys,
      semanticFormations
    );
  } catch (error) {
    params.warn("evidence context lookup for coverage and answer authority failed", {
      workspace_id: params.workspaceId,
      operation: "evidence_gist_lookup_for_coverage",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return emptyEvidenceContexts();
  }
}

async function loadQualifiedSemanticFormations(
  params: Parameters<typeof collectRecallEvidenceContexts>[0],
  evidenceIds: readonly string[]
): Promise<readonly RecallQualifiedEvidence[]> {
  const find = params.dependencies.evidenceSearchPort?.findRecallQualifiedByIds;
  if (find === undefined) return Object.freeze([]);
  try {
    return await find.call(
      params.dependencies.evidenceSearchPort,
      params.workspaceId,
      evidenceIds.map((objectId) => Object.freeze({ object_id: objectId }))
    );
  } catch (error) {
    params.warn("semantic factor evidence context lookup failed", {
      workspace_id: params.workspaceId,
      operation: "qualified_semantic_factor_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return Object.freeze([]);
  }
}

async function loadQualifiedFactKeys(
  params: Parameters<typeof collectRecallEvidenceContexts>[0],
  evidenceIds: readonly string[]
): Promise<readonly RecallQualifiedEvidence[]> {
  const find = params.dependencies.evidenceSearchPort
    ?.findRecallQualifiedFactKeysByIds;
  if (find === undefined) return Object.freeze([]);
  try {
    return await find.call(
      params.dependencies.evidenceSearchPort,
      params.workspaceId,
      evidenceIds
    );
  } catch (error) {
    params.warn("fact-key evidence context lookup failed", {
      workspace_id: params.workspaceId,
      operation: "qualified_fact_key_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return Object.freeze([]);
  }
}

function emptyEvidenceContexts(): Readonly<RecallEvidenceContexts> {
  return Object.freeze({
    evidenceGistsByMemoryId: Object.freeze({}),
    evidenceSemanticDocumentsByMemoryId: Object.freeze({}),
    verifiedUserAssertionContextsByMemoryId: Object.freeze({}),
    semanticFactorFormationsByEvidenceId: Object.freeze({})
  });
}

function collectRelevantCandidates(
  candidates: readonly Readonly<MemoryEntry>[],
  coarseEvidenceFtsRanks: Readonly<Record<string, number>>
): readonly Readonly<MemoryEntry>[] {
  return candidates.filter(
    (entry) =>
      entry.evidence_refs.length > 0 &&
      (coarseEvidenceFtsRanks[entry.object_id] ?? 0) > 0
  );
}

function collectRelevantEvidenceIds(
  candidates: readonly Readonly<MemoryEntry>[],
  ranksByRef: Readonly<Record<string, number>>
): readonly string[] {
  return uniqueStrings(candidates.flatMap((entry) =>
    selectRelevantEvidenceRefs(entry, ranksByRef)
  ));
}

function collectAuthorityEvidenceIds(
  candidates: readonly Readonly<MemoryEntry>[]
): readonly string[] {
  return uniqueStrings(candidates.flatMap((entry) =>
    stableEvidenceRefs(entry)
  ));
}

function selectRelevantEvidenceRefs(
  entry: Readonly<MemoryEntry>,
  ranksByRef: Readonly<Record<string, number>>
): readonly string[] {
  const hitRefs = entry.evidence_refs.filter((ref) => (ranksByRef[ref] ?? 0) > 0);
  if (hitRefs.length <= MAX_REFS_PER_MEMORY) return hitRefs;
  return [...hitRefs]
    .sort((left, right) => (ranksByRef[right] ?? 0) - (ranksByRef[left] ?? 0))
    .slice(0, MAX_REFS_PER_MEMORY);
}

function buildMemoryEvidenceContexts(
  workspaceId: string,
  gistCandidates: readonly Readonly<MemoryEntry>[],
  authorityCandidates: readonly Readonly<MemoryEntry>[],
  ranksByRef: Readonly<Record<string, number>>,
  capsules: readonly Readonly<EvidenceCapsule>[],
  qualifiedFactKeys: readonly Readonly<RecallQualifiedEvidence>[],
  qualifiedSemanticFormations: readonly Readonly<RecallQualifiedEvidence>[]
): Readonly<RecallEvidenceContexts> {
  const evidenceById = buildEvidenceById(workspaceId, capsules);
  const factKeysByEvidenceId = buildFactKeysByEvidenceId(qualifiedFactKeys);
  const gists: Record<string, string> = {};
  const semanticDocuments: Record<
    string,
    readonly Readonly<RecallEvidenceSemanticDocument>[]
  > = {};
  const contexts: Record<string, Readonly<RecallVerifiedUserAssertionContext>> = {};
  for (const entry of gistCandidates) {
    const refs = orderEvidenceRefs(entry, ranksByRef);
    const gist = refs.map((ref) => coverageGist(evidenceById.get(ref)))
      .find((value) => value !== undefined);
    if (gist !== undefined) gists[entry.object_id] = gist;
  }
  for (const entry of authorityCandidates) {
    const documents = semanticEvidenceDocuments(
      workspaceId, entry, evidenceById, factKeysByEvidenceId, ranksByRef
    );
    if (documents.length > 0) semanticDocuments[entry.object_id] = documents;
    const context = projectUniqueVerifiedContext(entry, evidenceById);
    if (context !== null) contexts[entry.object_id] = context;
  }
  return Object.freeze({
    evidenceGistsByMemoryId: Object.freeze(gists),
    evidenceSemanticDocumentsByMemoryId: Object.freeze(semanticDocuments),
    verifiedUserAssertionContextsByMemoryId: Object.freeze(contexts),
    semanticFactorFormationsByEvidenceId:
      buildSemanticFactorFormationsByEvidenceId(qualifiedSemanticFormations)
  });
}

function buildSemanticFactorFormationsByEvidenceId(
  qualified: readonly Readonly<RecallQualifiedEvidence>[]
): Readonly<Record<string, Readonly<OpenSemanticFactorFormationCapture>>> {
  const formations: Record<string, Readonly<OpenSemanticFactorFormationCapture>> = {};
  for (const item of qualified) {
    if (item.matched_projection !== undefined ||
        item.semantic_factor_formation === undefined) continue;
    formations[item.capsule.object_id] = item.semantic_factor_formation;
  }
  return Object.freeze(formations);
}

function buildFactKeysByEvidenceId(
  qualified: readonly Readonly<RecallQualifiedEvidence>[]
): ReadonlyMap<string, readonly Readonly<RecallQualifiedEvidence>[]> {
  const grouped = new Map<string, RecallQualifiedEvidence[]>();
  for (const item of qualified) {
    if (item.matched_projection?.projection_kind !== "fact_key") continue;
    const current = grouped.get(item.capsule.object_id) ?? [];
    current.push(item);
    grouped.set(item.capsule.object_id, current);
  }
  return new Map([...grouped].map(([evidenceId, items]) => [
    evidenceId,
    Object.freeze(items.sort((left, right) =>
      left.matched_projection!.projection_id - right.matched_projection!.projection_id
    ))
  ]));
}

function semanticEvidenceDocuments(
  workspaceId: string,
  entry: Readonly<MemoryEntry>,
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
  factKeysByEvidenceId: ReadonlyMap<
    string,
    readonly Readonly<RecallQualifiedEvidence>[]
  >,
  ranksByRef: Readonly<Record<string, number>>
): readonly Readonly<RecallEvidenceSemanticDocument>[] {
  return Object.freeze(orderEvidenceRefs(entry, ranksByRef)
    .slice(0, MAX_REFS_PER_MEMORY)
    .flatMap((ref) => {
      const evidence = evidenceById.get(ref)?.evidence;
      if (evidence === undefined) return [];
      const content = createBoundedNonMemoryPreview(
        evidence.excerpt ?? evidence.gist
      );
      const owner = !isDirectRecallEvidence(evidence, workspaceId) || content.length === 0
        ? []
        : [Object.freeze({
            evidenceRef: evidence.object_id,
            documentIdentity: "owner",
            content,
            projection: ownerProjectionReceipt()
          })];
      const factKeys = (factKeysByEvidenceId.get(evidence.object_id) ?? [])
        .flatMap((qualified) => {
          const projection = qualified.matched_projection;
          return projection?.projection_kind !== "fact_key" ? [] : [Object.freeze({
            evidenceRef: evidence.object_id,
            documentIdentity: `fact_key:${projection.projection_id}`,
            content: projection.content,
            projection: Object.freeze({
              projection_id: projection.projection_id,
              projection_kind: "fact_key" as const,
              matched_fact_key_forms: Object.freeze([
                ...(qualified.matched_fact_key_forms ?? [])
              ]),
              ...(qualified.matched_fact_frame === undefined ? {} : {
                fact_slots: Object.freeze(qualified.matched_fact_frame.slots.map((slot) =>
                  Object.freeze({ ...slot })
                ))
              })
            })
          })];
        });
      return [...owner, ...factKeys];
    }));
}

function ownerProjectionReceipt(): Readonly<RecallEvidenceSemanticProjectionReceipt> {
  return Object.freeze({
    projection_id: null,
    projection_kind: "owner",
    matched_fact_key_forms: Object.freeze([])
  });
}

function buildEvidenceById(
  workspaceId: string,
  capsules: readonly Readonly<EvidenceCapsule>[]
): ReadonlyMap<string, EvidenceRecord> {
  const evidenceById = new Map<string, EvidenceRecord>();
  for (const evidence of capsules) {
    if (evidence.workspace_id !== workspaceId) continue;
    evidenceById.set(evidence.object_id, Object.freeze({ evidence }));
  }
  return evidenceById;
}

function coverageGist(record: Readonly<EvidenceRecord> | undefined): string | undefined {
  const gist = record?.evidence.gist.trim() ?? "";
  return gist.length > 0 ? gist : undefined;
}

function orderEvidenceRefs(
  entry: Readonly<MemoryEntry>,
  ranksByRef: Readonly<Record<string, number>>
): readonly string[] {
  return [...entry.evidence_refs].sort(
    (left, right) =>
      (ranksByRef[right] ?? 0) - (ranksByRef[left] ?? 0) ||
      left.localeCompare(right)
  );
}

function projectUniqueVerifiedContext(
  entry: Readonly<MemoryEntry>,
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): Readonly<RecallVerifiedUserAssertionContext> | null {
  const taggedRecords = stableEvidenceRefs(entry).flatMap((evidenceRef) => {
    const record = evidenceById.get(evidenceRef);
    return record?.evidence.source_hash?.startsWith(
      VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX
    ) === true
      ? [record]
      : [];
  });
  if (taggedRecords.length !== 1) return null;
  const record = taggedRecords[0]!;
  if (!hasValidSourceReceipt(entry, record.evidence)) return null;
  return projectVerifiedUserAssertionContext({
    evidenceRef: record.evidence.object_id,
    entryContent: entry.content,
    gist: record.evidence.gist
  });
}

function stableEvidenceRefs(entry: Readonly<MemoryEntry>): readonly string[] {
  return [...uniqueStrings(entry.evidence_refs)].sort();
}

// Assertion-family source_hash qualifies recall and verified-assertion context;
// turn-fallback qualifies recall only — one column, two additive families.
function hasValidSourceReceipt(
  entry: Readonly<MemoryEntry>,
  evidence: Readonly<EvidenceCapsule>
): boolean {
  if (
    evidence.lifecycle_state !== "active" ||
    evidence.created_by !== "garden_compile" ||
    evidence.evidence_kind !== "conversation_excerpt" ||
    evidence.evidence_health_state !== "verified" ||
    evidence.workspace_id !== entry.workspace_id ||
    evidence.run_id !== entry.run_id ||
    evidence.surface_id !== entry.surface_id
  ) return false;
  const observedDigest = readVerifiedUserAssertionSourceHashDigest(evidence.source_hash);
  if (observedDigest === null) return false;
  const expectedDigest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: entry.workspace_id,
      run_id: entry.run_id,
      surface_id: entry.surface_id,
      source_assertion: entry.content,
      source_corpus: evidence.gist
    }), "utf8")
    .digest("hex");
  return observedDigest === expectedDigest;
}
