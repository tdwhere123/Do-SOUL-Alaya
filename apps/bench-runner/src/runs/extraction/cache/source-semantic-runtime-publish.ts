import type {
  SourceReferenceCatalog, SourceSemanticInterpretation, SourceSemanticPublishedInterpretation
} from "@do-soul/alaya-protocol";

type Publication = Readonly<{
  publish(input: Readonly<{
    workspaceId: string; runId: string; artifactKey: string; source: string; catalog: SourceReferenceCatalog;
    provenance: Readonly<{ producer_id: string; principal?: string; preparation_handle?: string }>;
    interpretation: SourceSemanticInterpretation; producer_version: string; contract_version: string;
  }>): Promise<Readonly<{ bound: SourceSemanticPublishedInterpretation; evidence: Readonly<{ object_id: string }> }>>;
}>;

/**
 * Typed cache artifacts stay unbound. Runtime recall hydrates H only after this
 * audited Core publication. Failed or empty H must not erase the original source.
 */
export async function publishAdmittedSourceSemanticInterpretation(input: Readonly<{
  publication: Publication; workspaceId: string; runId: string; artifactKey: string; source: string;
  catalog: SourceReferenceCatalog; interpretation: SourceSemanticInterpretation;
  producer_id: string; producer_version: string; contract_version: string;
}>) {
  return input.publication.publish({
    workspaceId: input.workspaceId, runId: input.runId, artifactKey: input.artifactKey,
    source: input.source, catalog: input.catalog, interpretation: input.interpretation,
    provenance: { producer_id: input.producer_id }, producer_version: input.producer_version,
    contract_version: input.contract_version
  });
}
