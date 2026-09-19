import {
  buildSourceReferenceCatalog, canonicalJson, sourceReferenceResolver, sourceSemanticStanceLists,
  SourceSemanticInterpretationSchema, SourceSemanticResourceLedger, sourceReferencePreparationCost,
  type SourceSemanticInterpretation, type SourceReferenceCatalog, type FieldContractSha256
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { sliceUtf8Span, sourceSpanFromCodeUnitOffsets } from "./source-span-views.js";

type Locations = NonNullable<SourceSemanticInterpretation["source"]["assertion_locations"]>;

/** Source-local selectors are always re-resolved, including the already-normalized entrance. */
export function bindSourceSemanticLocations(input: Readonly<{
  source: string; interpretation: SourceSemanticInterpretation; catalog: SourceReferenceCatalog;
  locations?: Locations; sha256: FieldContractSha256; meter?: SourceSemanticResourceLedger;
}>): SourceSemanticInterpretation {
  const { source, interpretation: h, catalog, sha256 } = input;
  input.meter?.retain(h, "source location verification");
  const cost = sourceReferencePreparationCost(catalog.assertions.map((row) => ({ assertion_id: row.assertion_id, text: row.segments.map((segment) => segment.text).join("") })));
  input.meter?.charge(cost.work_units, cost.memory_bytes, "source reference verification");
  const resolver = sourceReferenceResolver(catalog, sha256);
  const locations = locateAssertions(source, catalog, input.locations ?? h.source.assertion_locations);
  const byId = new Map(locations.map((row) => [row.assertion_id, row.source_utf8_span]));
  if ([...h.frames, ...h.operators].some((row) => row.assertion_ids.some((id) => !byId.has(id)))) {
    throw new CoreError("VALIDATION", "interpretation names an unselected source assertion");
  }
  const mentions = h.mentions.map((mention) => {
    const located = resolver.resolve(catalog.catalog_id, mention.assertion_id, mention.source_ref);
    const assertionSpan = byId.get(mention.assertion_id)!;
    const assertion = utf8Slice(source, assertionSpan);
    const local = byteSpan(assertion, located.span);
    const absolute = [assertionSpan[0] + local[0], assertionSpan[0] + local[1]] as const;
    const expected = mention.span_space === "source_utf8" ? absolute : located.span;
    if (mention.text !== located.text || canonicalJson(mention.utf8_span) !== canonicalJson(expected)) {
      throw new CoreError("VALIDATION", "normalized mention differs from its exact source reference");
    }
    return { ...mention, text: located.text, utf8_span: absolute, span_space: "source_utf8" as const };
  });
  return SourceSemanticInterpretationSchema.parse({ ...h, mentions,
    source: { ...h.source, assertion_locations: locations },
    ...sourceSemanticStanceLists([...h.frames, ...h.operators]) });
}

/** Old unique-text catalogs are an explicit compatibility adapter. Repeated text needs host locations. */
function locateAssertions(source: string, catalog: SourceReferenceCatalog, supplied: Locations | undefined): Locations {
  const sourceBytes = Buffer.byteLength(source);
  const byId = new Map((supplied ?? []).map((row) => [row.assertion_id, row.source_utf8_span]));
  if (supplied !== undefined && (byId.size !== supplied.length || supplied.length !== catalog.assertions.length)) {
    throw new CoreError("VALIDATION", "assertion locations do not cover this catalog exactly");
  }
  return [...catalog.assertions].sort((a, b) => a.assertion_id - b.assertion_id).map((row) => {
    const text = row.segments.map((part) => part.text).join("");
    let span = byId.get(row.assertion_id);
    if (supplied !== undefined && span === undefined) throw new CoreError("VALIDATION", "assertion location is absent");
    if (span === undefined) {
      const start = source.indexOf(text);
      if (start < 0 || source.indexOf(text, start + 1) >= 0) {
        throw new CoreError("VALIDATION", "repeated assertion requires a host-owned source location");
      }
      span = byteSpan(source, [start, start + text.length]);
    }
    if (span[1] > sourceBytes || utf8Slice(source, span) !== text) throw new CoreError("VALIDATION", "assertion location differs from source text");
    return { assertion_id: row.assertion_id, source_utf8_span: span };
  });
}

export function verifySourceSemanticLocations(source: string, h: SourceSemanticInterpretation, sha256: FieldContractSha256, meter?: SourceSemanticResourceLedger): SourceSemanticInterpretation {
  const locations = h.source.assertion_locations;
  if (locations === undefined) throw new CoreError("VALIDATION", "interpretation has no host-owned assertion locations");
  if (h.mentions.some((row) => row.span_space !== "source_utf8")) throw new CoreError("VALIDATION", "durable interpretation requires source UTF-8 coordinates");
  const catalog = buildSourceReferenceCatalog(sha256(source), locations.map((row) => ({
    assertion_id: row.assertion_id, text: utf8Slice(source, row.source_utf8_span)
  })), sha256);
  return bindSourceSemanticLocations({ source, interpretation: h, catalog, locations, sha256, meter });
}

function utf8Slice(source: string, span: readonly [number, number]): string {
  return sliceUtf8Span(source, { start_offset: span[0], end_offset: span[1], purpose: "native_structure" });
}

function byteSpan(source: string, span: readonly [number, number]): readonly [number, number] {
  const located = sourceSpanFromCodeUnitOffsets(source, { start_offset: span[0], end_offset: span[1], purpose: "native_structure" });
  return [located.start_offset, located.end_offset];
}
