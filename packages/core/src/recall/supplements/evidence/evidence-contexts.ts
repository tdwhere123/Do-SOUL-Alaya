import { createHash } from "node:crypto";
import type { EvidenceCapsule, MemoryEntry } from "@do-soul/alaya-protocol";
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
  RecallServiceWarnPort
} from "../../runtime/recall-service-types.js";

const MAX_REFS_PER_MEMORY = 8;

export interface RecallEvidenceContexts {
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  readonly evidenceSemanticDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
  readonly verifiedUserAssertionContextsByMemoryId: Readonly<
    Record<string, Readonly<RecallVerifiedUserAssertionContext>>
  >;
}

export interface RecallEvidenceSemanticDocument {
  readonly evidenceRef: string;
  readonly documentIdentity: string;
  readonly content: string;
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
    const capsules = await evidenceSearchPort.findByIds(params.workspaceId, evidenceIds);
    return buildMemoryEvidenceContexts(
      params.workspaceId,
      gistCandidates,
      authorityCandidates,
      params.coarseEvidenceFtsRanksPerRef,
      capsules
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

function emptyEvidenceContexts(): Readonly<RecallEvidenceContexts> {
  return Object.freeze({
    evidenceGistsByMemoryId: Object.freeze({}),
    evidenceSemanticDocumentsByMemoryId: Object.freeze({}),
    verifiedUserAssertionContextsByMemoryId: Object.freeze({})
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
  capsules: readonly Readonly<EvidenceCapsule>[]
): Readonly<RecallEvidenceContexts> {
  const evidenceById = buildEvidenceById(workspaceId, capsules);
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
      workspaceId, entry, evidenceById, ranksByRef
    );
    if (documents.length > 0) semanticDocuments[entry.object_id] = documents;
    const context = projectUniqueVerifiedContext(entry, evidenceById);
    if (context !== null) contexts[entry.object_id] = context;
  }
  return Object.freeze({
    evidenceGistsByMemoryId: Object.freeze(gists),
    evidenceSemanticDocumentsByMemoryId: Object.freeze(semanticDocuments),
    verifiedUserAssertionContextsByMemoryId: Object.freeze(contexts)
  });
}

function semanticEvidenceDocuments(
  workspaceId: string,
  entry: Readonly<MemoryEntry>,
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
  ranksByRef: Readonly<Record<string, number>>
): readonly Readonly<RecallEvidenceSemanticDocument>[] {
  return Object.freeze(orderEvidenceRefs(entry, ranksByRef)
    .slice(0, MAX_REFS_PER_MEMORY)
    .flatMap((ref) => {
      const evidence = evidenceById.get(ref)?.evidence;
      if (evidence === undefined ||
          !isDirectRecallEvidence(evidence, workspaceId)) return [];
      const content = createBoundedNonMemoryPreview(
        evidence.excerpt ?? evidence.gist
      );
      return content.length === 0 ? [] : [Object.freeze({
        evidenceRef: evidence.object_id,
        documentIdentity: "owner",
        content
      })];
    }));
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
