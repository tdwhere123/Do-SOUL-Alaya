import { OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY } from "@do-soul/alaya-protocol";

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
