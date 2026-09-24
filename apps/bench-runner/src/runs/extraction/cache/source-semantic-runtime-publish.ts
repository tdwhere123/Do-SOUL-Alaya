import { AlayaError, type SourceReferenceCatalog, type SourceSemanticInterpretation, type UtteranceAttribution,
  type SourceSemanticPublishedInterpretation } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";

type Locations = NonNullable<SourceSemanticInterpretation["source"]["assertion_locations"]>;

type Publication = Readonly<{
  publish(input: Readonly<{
    workspaceId: string; runId: string; artifactKey: string; source: string; catalog: SourceReferenceCatalog;
    attribution_context: UtteranceAttribution;
    provenance: Readonly<{ producer_id: string; principal?: string; preparation_handle?: string }>;
    interpretation?: SourceSemanticInterpretation; draft?: unknown; assertion_locations: Locations;
    producer_version: string; contract_version: string;
  }>): Promise<Readonly<{ bound: SourceSemanticPublishedInterpretation; evidence: Readonly<{ object_id: string }> }>>;
}>;

/**
 * Typed cache artifacts stay unbound. Runtime recall hydrates a source interpretation only after this
 * audited Core publication. Failed or empty source interpretation must not erase the original source.
 */
export async function publishAdmittedSourceSemanticInterpretation(input: Readonly<{
  publication: Publication; workspaceId: string; runId: string; artifactKey: string; source: string;
  catalog: SourceReferenceCatalog; producer_id: string; producer_version: string; contract_version: string;
  attribution_context: UtteranceAttribution;
  interpretation?: SourceSemanticInterpretation; draft?: unknown; assertion_locations: Locations;
}>) {
  const hasInterpretation = input.interpretation !== undefined;
  const hasDraft = input.draft !== undefined;
  if (hasInterpretation === hasDraft) {
    throw new AlayaError("VALIDATION", "source semantic publication accepts a draft or a normalized interpretation, not both");
  }
  if (fieldContractSha256(input.source) !== input.catalog.source_digest) {
    throw new AlayaError("VALIDATION", "publication source digest differs from the request catalog");
  }
  const assertionLocations = verifyRequestOwnedLocations(input.source, input.catalog, input.assertion_locations);
  return input.publication.publish({
    workspaceId: input.workspaceId, runId: input.runId, artifactKey: input.artifactKey,
    source: input.source, catalog: input.catalog,
    attribution_context: input.attribution_context,
    provenance: { producer_id: input.producer_id },
    producer_version: input.producer_version, contract_version: input.contract_version,
    ...(hasInterpretation ? { interpretation: input.interpretation } : { draft: input.draft }),
    assertion_locations: assertionLocations
  });
}

/** Host locations must cover the catalog exactly. Never pick the first repeated substring. */
export function verifyRequestOwnedLocations(
  source: string, catalog: SourceReferenceCatalog, locations: Locations
): Locations {
  const byId = new Map(locations.map((row) => [row.assertion_id, row.source_utf8_span]));
  if (byId.size !== locations.length || locations.length !== catalog.assertions.length) {
    throw new AlayaError("VALIDATION", "assertion locations do not cover this catalog exactly");
  }
  const sourceBytes = Buffer.byteLength(source, "utf8");
  return [...catalog.assertions].sort((left, right) => left.assertion_id - right.assertion_id).map((row) => {
    const span = byId.get(row.assertion_id);
    if (span === undefined) throw new AlayaError("VALIDATION", "assertion location is absent");
    const text = row.segments.map((part) => part.text).join("");
    if (span[1] > sourceBytes || utf8Slice(source, span) !== text) {
      throw new AlayaError("VALIDATION", "assertion location differs from source text");
    }
    return { assertion_id: row.assertion_id, source_utf8_span: span };
  });
}

function utf8Slice(source: string, span: readonly [number, number]): string {
  return Buffer.from(source, "utf8").subarray(span[0], span[1]).toString("utf8");
}
