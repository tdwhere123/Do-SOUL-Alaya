import type { EvidenceCapsule } from "@do-soul/alaya-protocol";
import { OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY } from "@do-soul/alaya-protocol";
import { createBoundedNonMemoryPreview } from
  "../../coarse-filter/non-memory-preview.js";
import { isDirectRecallEvidence } from
  "../../coarse-filter/evidence/direct-evidence-candidate.js";
import type {
  RecallEvidenceSemanticDocument,
  RecallEvidenceSemanticProjectionReceipt
} from "../../runtime/recall-service-types.js";

interface SemanticDocumentIdentity {
  readonly documentIdentity: string;
  readonly content: string;
}

export function preferOwnerGistDocumentIdentity<T extends SemanticDocumentIdentity>(
  documents: readonly T[],
  ownerIdentity: (document: T) => string
): readonly T[] {
  const gistContentsByOwner = new Map<string, Set<string>>();
  for (const document of documents) {
    if (document.documentIdentity !== OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY) continue;
    const contents = gistContentsByOwner.get(ownerIdentity(document)) ?? new Set();
    contents.add(document.content);
    gistContentsByOwner.set(ownerIdentity(document), contents);
  }
  return Object.freeze(documents.filter((document) =>
    document.documentIdentity !== "owner" ||
    !gistContentsByOwner.get(ownerIdentity(document))?.has(document.content)
  ));
}

export function ownerSemanticDocuments(
  evidence: Readonly<EvidenceCapsule>,
  workspaceId: string
): readonly Readonly<RecallEvidenceSemanticDocument>[] {
  if (!isDirectRecallEvidence(evidence, workspaceId)) return [];
  const excerpt = evidence.excerpt === null
    ? ""
    : createBoundedNonMemoryPreview(evidence.excerpt);
  const gist = createBoundedNonMemoryPreview(evidence.gist);
  const documents = [
    ...semanticDocument(evidence.object_id, "owner", excerpt),
    ...semanticDocument(
      evidence.object_id,
      OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY,
      gist
    )
  ];
  return preferOwnerGistDocumentIdentity(documents, ({ evidenceRef }) => evidenceRef);
}

function semanticDocument(
  evidenceRef: string,
  documentIdentity: string,
  content: string
): readonly Readonly<RecallEvidenceSemanticDocument>[] {
  if (content.length === 0) return [];
  return [Object.freeze({
    evidenceRef,
    documentIdentity,
    content,
    projection: ownerProjectionReceipt()
  })];
}

function ownerProjectionReceipt(): Readonly<RecallEvidenceSemanticProjectionReceipt> {
  return Object.freeze({
    projection_id: null,
    projection_kind: "owner",
    matched_fact_key_forms: Object.freeze([])
  });
}
