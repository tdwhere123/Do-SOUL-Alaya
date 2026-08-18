import type {
  EvidenceCapsule,
  MemoryEntry,
  OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import {
  VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX,
  VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX,
  parseVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import {
  projectVerifiedUserAssertionContext,
  type RecallVerifiedUserAssertionContext
} from "../../query/recall-user-assertion-context.js";
import { uniqueStrings } from "../../expansion/path-relations.js";
import type { RecallQualifiedEvidence } from "../../runtime/recall-service-ports.js";
import type { RecallEvidenceSemanticDocument } from "../../runtime/recall-service-types.js";
import { compareText } from "../../../shared/compare-text.js";
import { ownerSemanticDocuments } from "./owner-semantic-documents.js";
import {
  MAX_REFS_PER_MEMORY,
  type EvidenceRecord,
  type RecallEvidenceContexts
} from "./evidence-contexts-types.js";

export function emptyEvidenceContexts(
  unavailableEvidenceIds: readonly string[] = []
): Readonly<RecallEvidenceContexts> {
  return Object.freeze({
    evidenceGistsByMemoryId: Object.freeze({}),
    evidenceSemanticDocumentsByMemoryId: Object.freeze({}),
    verifiedUserAssertionContextsByMemoryId: Object.freeze({}),
    semanticFactorFormationsByEvidenceId: Object.freeze({}),
    ...(unavailableEvidenceIds.length === 0
      ? {}
      : {
          semanticFactorFormationUnavailableEvidenceIds: Object.freeze([...new Set(unavailableEvidenceIds)].sort(compareText))
        })
  });
}
export function buildMemoryEvidenceContexts(
  workspaceId: string,
  gistCandidates: readonly Readonly<MemoryEntry>[],
  authorityCandidates: readonly Readonly<MemoryEntry>[],
  ranksByRef: Readonly<Record<string, number>>,
  capsules: readonly Readonly<EvidenceCapsule>[],
  qualifiedFactKeys: readonly Readonly<RecallQualifiedEvidence>[],
  qualifiedSemanticFormations: readonly Readonly<RecallQualifiedEvidence>[],
  semanticUnavailableEvidenceIds: readonly string[]
): Readonly<RecallEvidenceContexts> {
  const evidenceById = buildEvidenceById(workspaceId, capsules);
  const qualifiedAssertionEvidenceIds = collectQualifiedAssertionEvidenceIds(
    qualifiedSemanticFormations
  );
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
      workspaceId,
      entry,
      evidenceById,
      factKeysByEvidenceId,
      qualifiedAssertionEvidenceIds,
      ranksByRef
    );
    if (documents.length > 0) semanticDocuments[entry.object_id] = documents;
    const context = projectUniqueVerifiedContext(
      entry,
      evidenceById,
      qualifiedAssertionEvidenceIds
    );
    if (context !== null) contexts[entry.object_id] = context;
  }
  return Object.freeze({
    evidenceGistsByMemoryId: Object.freeze(gists),
    evidenceSemanticDocumentsByMemoryId: Object.freeze(semanticDocuments),
    verifiedUserAssertionContextsByMemoryId: Object.freeze(contexts),
    semanticFactorFormationsByEvidenceId:
      buildSemanticFactorFormationsByEvidenceId(qualifiedSemanticFormations),
    ...buildUnavailableSemanticFactorEvidenceIds(
      qualifiedSemanticFormations,
      semanticUnavailableEvidenceIds
    )
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

function buildUnavailableSemanticFactorEvidenceIds(
  qualified: readonly Readonly<RecallQualifiedEvidence>[],
  explicitIds: readonly string[]
): Readonly<{ readonly semanticFactorFormationUnavailableEvidenceIds?: readonly string[] }> {
  const ids = [...new Set([
    ...explicitIds,
    ...qualified
      .filter((item) => item.matched_projection === undefined &&
        item.semantic_factor_formation === undefined)
      .map((item) => item.capsule.object_id)
  ])]
    .sort(compareText);
  return ids.length === 0
    ? {}
    : { semanticFactorFormationUnavailableEvidenceIds: Object.freeze(ids) };
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
  qualifiedAssertionEvidenceIds: ReadonlySet<string>,
  ranksByRef: Readonly<Record<string, number>>
): readonly Readonly<RecallEvidenceSemanticDocument>[] {
  return Object.freeze(orderEvidenceRefs(entry, ranksByRef)
    .slice(0, MAX_REFS_PER_MEMORY)
    .flatMap((ref) => {
      const evidence = evidenceById.get(ref)?.evidence;
      if (evidence === undefined) return [];
      const owner = ownerSemanticDocuments(
        evidence,
        workspaceId,
        hasQualifiedSourceReceipt(entry, evidence, qualifiedAssertionEvidenceIds)
      );
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
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
  qualifiedAssertionEvidenceIds: ReadonlySet<string>
): Readonly<RecallVerifiedUserAssertionContext> | null {
  const taggedRecords = stableEvidenceRefs(entry).flatMap((evidenceRef) => {
    const record = evidenceById.get(evidenceRef);
    return record !== undefined && hasAssertionFamilyTag(record.evidence.source_hash)
      ? [record] : [];
  });
  if (taggedRecords.length !== 1) return null;
  const record = taggedRecords[0]!;
  if (!hasQualifiedSourceReceipt(
    entry,
    record.evidence,
    qualifiedAssertionEvidenceIds
  )) return null;
  return projectVerifiedUserAssertionContext({
    evidenceRef: record.evidence.object_id,
    entryContent: entry.content,
    gist: record.evidence.gist
  });
}

export function stableEvidenceRefs(entry: Readonly<MemoryEntry>): readonly string[] {
  return [...uniqueStrings(entry.evidence_refs)].sort();
}

function collectQualifiedAssertionEvidenceIds(
  qualified: readonly Readonly<RecallQualifiedEvidence>[]
): ReadonlySet<string> {
  return new Set(qualified.flatMap((item) =>
    item.matched_projection === undefined &&
    parseVerifiedUserAssertionSourceHash(item.capsule.source_hash) !== null
      ? [item.capsule.object_id] : []
  ));
}

function hasAssertionFamilyTag(sourceHash: string | null): boolean {
  return sourceHash?.startsWith(VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX) === true ||
    sourceHash?.startsWith(VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX) === true;
}

// Storage owns receipt, Signal, and EventLog qualification. Core only binds
// that qualified capsule to the selected memory before projecting context.
function hasQualifiedSourceReceipt(
  entry: Readonly<MemoryEntry>,
  evidence: Readonly<EvidenceCapsule>,
  qualifiedAssertionEvidenceIds: ReadonlySet<string>
): boolean {
  if (
    !qualifiedAssertionEvidenceIds.has(evidence.object_id) ||
    evidence.lifecycle_state !== "active" ||
    evidence.created_by !== "garden_compile" ||
    evidence.evidence_kind !== "conversation_excerpt" ||
    evidence.evidence_health_state !== "verified" ||
    evidence.workspace_id !== entry.workspace_id ||
    evidence.run_id !== entry.run_id ||
    evidence.surface_id !== entry.surface_id ||
    evidence.excerpt !== entry.content
  ) return false;
  return parseVerifiedUserAssertionSourceHash(evidence.source_hash) !== null;
}
