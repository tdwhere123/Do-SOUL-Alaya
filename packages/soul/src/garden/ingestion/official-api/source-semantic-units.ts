import { createHash } from "node:crypto";
import { z } from "zod";
import { DEFAULT_EXTRACTION_SOURCE_PACKING, extractionSourcePackingSize,
  type ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import { sentenceSpans } from "../../triage/grounding/source-assertion/clause-spans.js";
import { collectSourceRoleMarkers } from "../../triage/grounding/source-role/marker.js";

export const SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT = "source-semantic-units-v1" as const;
export const SourceSemanticSourceRoleSchema = z.enum(["user", "assistant"]);
type SourceRole = z.infer<typeof SourceSemanticSourceRoleSchema>;

export interface SourceSemanticSourceUnit {
  readonly assertion_id: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly source_role: SourceRole;
}

interface SourceSemanticSourcePack {
  readonly source_unit_contract: typeof SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT;
  readonly source_corpus_identity: string;
  readonly source_scope?: "complete-source";
  readonly source_assertions: readonly Pick<SourceSemanticSourceUnit, "assertion_id" | "text" | "source_role">[];
}

/** Source boundaries are not assertion eligibility: retain questions, fragments and scoped clauses. */
export function indexSourceSemanticUnits(sourceCorpus: string, sourceRole?: SourceRole): readonly SourceSemanticSourceUnit[] {
  // A known single-source author owns quoted marker-looking text as well.
  const markers = sourceRole === undefined ? collectSourceRoleMarkers(sourceCorpus) : [];
  let markerIndex = 0;
  let source_role: SourceRole = sourceRole === undefined ? "user" : SourceSemanticSourceRoleSchema.parse(sourceRole);
  return sentenceSpans(sourceCorpus).map((span, index) => {
    while (markerIndex < markers.length && markers[markerIndex]!.start <= span.start) {
      source_role = markers[markerIndex++]!.role;
    }
    return { assertion_id: index + 1, text: sourceCorpus.slice(span.start, span.end),
      start: span.start, end: span.end, source_role };
  });
}

export function selectSourceSemanticUnits(sourceCorpus: string, assertionIds: readonly number[], sourceRole?: SourceRole): readonly SourceSemanticSourceUnit[] {
  const byId = new Map(indexSourceSemanticUnits(sourceCorpus, sourceRole).map((unit) => [unit.assertion_id, unit]));
  if (new Set(assertionIds).size !== assertionIds.length) throw new TypeError("duplicate requested source unit");
  return assertionIds.map((id) => {
    const unit = byId.get(id);
    if (unit === undefined) throw new TypeError("requested source unit is outside source corpus");
    return unit;
  });
}

export function collectSourceSemanticUnitPacks(sourceCorpus: string,
  packing: ExtractionSourcePacking = DEFAULT_EXTRACTION_SOURCE_PACKING, sourceRole?: SourceRole): readonly SourceSemanticSourcePack[] {
  const units = indexSourceSemanticUnits(sourceCorpus, sourceRole);
  const source_corpus_identity = digest({ contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT, sourceCorpus });
  if (packing === "complete-source") {
    return [{ source_unit_contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT, source_corpus_identity,
      source_scope: "complete-source" as const,
      source_assertions: units.map(({ assertion_id, text, source_role }) => ({ assertion_id, text, source_role })) }];
  }
  const size = extractionSourcePackingSize(packing);
  const packs: SourceSemanticSourcePack[] = [];
  for (let offset = 0; offset < Math.max(units.length, 1); offset += size) {
    packs.push({ source_unit_contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT, source_corpus_identity,
      source_assertions: units.slice(offset, offset + size).map(({ assertion_id, text, source_role }) => ({ assertion_id, text, source_role })) });
  }
  return packs;
}

/** Transport occurrence identity does not claim Garden assertion eligibility or semantic equivalence. */
export function sourceSemanticTransportUnits(sourceCorpus: string, messageIds: readonly string[], datasetRevision: string, sourceRole?: SourceRole) {
  const sourceDigest = digest(sourceCorpus);
  return indexSourceSemanticUnits(sourceCorpus, sourceRole).map((unit) => ({
    assertionId: unit.assertion_id, text: unit.text, sourceCorpus,
    binding: { occurrenceIdentity: digest({ contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT,
      sourceDigest, source_role: unit.source_role, start: unit.start, end: unit.end, messageIds, datasetRevision }) }
  }));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
