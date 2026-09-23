import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";
import { SourceAssertionIdSchema, SourceTextSpanSchema } from "./source-selection.js";
import { Sha256HexSchema, Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";

export const SOURCE_REFERENCE_MAX_ASSERTIONS = 64;
export const SOURCE_REFERENCE_MAX_SEGMENTS = 32768;
export const SOURCE_REFERENCE_MAX_TEXT_UNITS = 65536;
const SEGMENT_PATTERN = /[A-Za-z0-9_]+|[^]/gu;
const SegmentId = z.string().regex(/^a[1-9][0-9]*s[0-9]+$/u).max(48);
const Segment = z.object({ id: SegmentId, text: z.string().min(1).max(SOURCE_REFERENCE_MAX_TEXT_UNITS) }).strict().readonly();
const CatalogBody = z.object({ contract: z.literal("ascii-run-unicode-scalar-v1"), source_digest: Sha256HexSchema,
  assertions: z.array(z.object({ assertion_id: SourceAssertionIdSchema,
    segments: z.array(Segment).min(1).max(SOURCE_REFERENCE_MAX_SEGMENTS).readonly() }).strict().readonly()).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly()
}).strict();
export const SourceReferenceCatalogSchema = CatalogBody.extend({ catalog_id: Sha256DigestSchema }).strict().readonly();
export const SourceReferenceSchema = z.object({ first: SegmentId, last: SegmentId }).strict().readonly();
export type SourceReferenceCatalog = z.infer<typeof SourceReferenceCatalogSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
type Assertion = Readonly<{ assertion_id: number; text: string }>;

const CAPACITY_LIMITS = { assertions: SOURCE_REFERENCE_MAX_ASSERTIONS,
  text_units: SOURCE_REFERENCE_MAX_TEXT_UNITS, segments: SOURCE_REFERENCE_MAX_SEGMENTS } as const;
export const SourceReferenceCapacityReasonSchema = z.object({
  dimension: z.enum(["assertions", "text_units", "segments"]),
  actual: z.number().int().nonnegative(), limit: z.number().int().positive()
}).strict().superRefine((reason, context) => {
  if (reason.limit !== CAPACITY_LIMITS[reason.dimension] || reason.actual <= reason.limit) {
    context.addIssue({ code: "custom", message: "source reference capacity reason is inconsistent" });
  }
}).readonly();
export type SourceReferenceCapacityReason = z.infer<typeof SourceReferenceCapacityReasonSchema>;

export class SourceReferenceCapacityExceeded extends AlayaError {
  public constructor(public readonly reason: SourceReferenceCapacityReason) {
    super("VALIDATION", `source reference catalog exceeds its ${reason.dimension} bound (${reason.actual}/${reason.limit})`);
  }
}

/** Validate source membership before classifying only representation capacity. */
function assertionCapacityReason(assertions: readonly Assertion[]): SourceReferenceCapacityReason | null {
  const ids = new Set<number>();
  let textUnits = 0;
  for (const row of assertions) {
    SourceAssertionIdSchema.parse(row.assertion_id);
    if (typeof row.text !== "string" || row.text.length === 0) {
      throw new AlayaError("VALIDATION", "source reference catalog has an invalid assertion text");
    }
    if (ids.has(row.assertion_id)) throw new AlayaError("VALIDATION", "source reference catalog has duplicate assertion identities");
    ids.add(row.assertion_id);
    if (/[\uD800-\uDFFF]/u.test(row.text)) throw new AlayaError("VALIDATION", "source reference catalog contains an unpaired surrogate");
    textUnits += row.text.length;
  }
  if (assertions.length > SOURCE_REFERENCE_MAX_ASSERTIONS) return { dimension: "assertions", actual: assertions.length, limit: SOURCE_REFERENCE_MAX_ASSERTIONS };
  if (textUnits > SOURCE_REFERENCE_MAX_TEXT_UNITS) return { dimension: "text_units", actual: textUnits, limit: SOURCE_REFERENCE_MAX_TEXT_UNITS };
  return null;
}

export function sourceReferenceCapacityReason(assertions: readonly Assertion[]): SourceReferenceCapacityReason | null {
  const capacity = assertionCapacityReason(assertions);
  if (capacity !== null) return capacity;
  const textUnits = assertions.reduce((sum, row) => sum + row.text.length, 0);
  if (textUnits <= SOURCE_REFERENCE_MAX_SEGMENTS) return null;
  let segments = 0;
  for (const row of assertions) for (const _segment of row.text.matchAll(SEGMENT_PATTERN)) segments++;
  return segments > SOURCE_REFERENCE_MAX_SEGMENTS ? { dimension: "segments", actual: segments, limit: SOURCE_REFERENCE_MAX_SEGMENTS } : null;
}

function* selectedSegments(assertions: readonly Assertion[]) {
  const capacity = assertionCapacityReason(assertions);
  if (capacity !== null) throw new SourceReferenceCapacityExceeded(capacity);
  let segments = 0;
  for (const row of assertions) {
    let ordinal = 0;
    for (const match of row.text.matchAll(SEGMENT_PATTERN)) {
      if (++segments > SOURCE_REFERENCE_MAX_SEGMENTS) throw new SourceReferenceCapacityExceeded({
        dimension: "segments", actual: segments, limit: SOURCE_REFERENCE_MAX_SEGMENTS });
      yield { assertion_id: row.assertion_id, id: `a${row.assertion_id}s${ordinal}`, text: match[0],
        start: match.index, end: match.index + match[0].length, ordinal };
      ordinal += 1;
    }
  }
}

/** Conservative logical workspace for catalog validation, canonical strings and endpoint indexes; not process RSS. */
export function sourceReferencePreparationCost(assertions: readonly Assertion[]) {
  const encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  let catalogBytes = 512 + assertions.reduce((sum, row) => sum + size({ assertion_id: row.assertion_id, segments: [] }), 0);
  let indexBytes = 0;
  let work = assertions.reduce((sum, row) => sum + row.text.length + 1, 0);
  for (const segment of selectedSegments(assertions)) {
    catalogBytes += size({ id: segment.id, text: segment.text }) + 1;
    indexBytes += size(segment) + 1;
    work += 1;
  }
  // Includes source/catalog schemas' copies and canonical comparisons, not only the final retained map.
  return { work_units: work, memory_bytes: 10 * catalogBytes + 2 * indexBytes +
    2 * assertions.reduce((sum, row) => sum + row.text.length, 0) };
}

/** ASCII word runs, then individual Unicode scalars, including each whitespace character. No normalization. */
export function buildSourceReferenceCatalog(sourceDigest: string,
  assertions: readonly Assertion[], sha256: FieldContractSha256): SourceReferenceCatalog {
  const selected = assertions.map((row) => ({ assertion_id: row.assertion_id, segments: [] as { id: string; text: string }[] }));
  const groups = new Map(selected.map((row) => [row.assertion_id, row.segments]));
  for (const segment of selectedSegments(assertions)) groups.get(segment.assertion_id)!.push({ id: segment.id, text: segment.text });
  const body = CatalogBody.parse({ contract: CatalogBody.shape.contract.value, source_digest: sourceDigest, assertions: selected });
  return SourceReferenceCatalogSchema.parse({ ...body, catalog_id: `sha256:${sha256(canonicalJson(body))}` });
}

/** One validation and indexing pass; all consumers resolve through this same exact boundary owner. */
export function sourceReferenceResolver(value: SourceReferenceCatalog, sha256: FieldContractSha256) {
  const catalog = SourceReferenceCatalogSchema.parse(value);
  const expected = buildSourceReferenceCatalog(catalog.source_digest, catalog.assertions.map((row) => ({
    assertion_id: row.assertion_id, text: row.segments.map((segment) => segment.text).join("") })), sha256);
  if (canonicalJson(catalog) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "source reference catalog identity/content mismatch");
  }
  const byId = new Map<string, { assertion_id: number; start: number; end: number; ordinal: number }>();
  const assertions = new Map<number, { text: string; segments: typeof catalog.assertions[number]["segments"] }>();
  for (const row of catalog.assertions) {
    let offset = 0;
    row.segments.forEach((segment, ordinal) => {
      byId.set(segment.id, { assertion_id: row.assertion_id, start: offset, end: offset + segment.text.length, ordinal });
      offset += segment.text.length;
    });
    assertions.set(row.assertion_id, { text: row.segments.map((segment) => segment.text).join(""), segments: row.segments });
  }
  const selectionIndex = new Map<number, { starts: Map<number, string>; ends: Map<number, string> }>();
  return {
    resolve(catalogId: string, assertionId: number, value: SourceReference) {
      const reference = SourceReferenceSchema.parse(value);
      if (catalogId !== catalog.catalog_id) throw new AlayaError("CONFLICT", "source reference belongs to a foreign catalog");
      const first = byId.get(reference.first);
      const last = byId.get(reference.last);
      if (first === undefined || last === undefined || first.assertion_id !== assertionId || last.assertion_id !== assertionId) {
        throw new AlayaError("CONFLICT", "source reference has missing or cross-assertion endpoints");
      }
      if (first.ordinal > last.ordinal) throw new AlayaError("CONFLICT", "source reference endpoints are reversed");
      return { text: assertions.get(assertionId)!.text.slice(first.start, last.end),
        span: [first.start, last.end] as const };
    },
    referenceForSpan(assertionId: number, value: readonly [number, number]): SourceReference {
      const [start, end] = SourceTextSpanSchema.parse(value);
      const row = assertions.get(assertionId);
      const first = row?.segments.find((segment) => byId.get(segment.id)!.start === start);
      const last = row?.segments.find((segment) => byId.get(segment.id)!.end === end);
      if (first === undefined || last === undefined) {
        throw new AlayaError("VALIDATION", "unsupported source reference boundary inside a segment");
      }
      return { first: first.id, last: last.id };
    },
    /** Occurrences are zero-based among catalog-eligible exact matches, including overlaps. */
    selectExactText(assertionId: number, selection: Readonly<{ text: string; occurrence?: number }>,
      account: (work: number, bytes: number) => void):
      { readonly reference: SourceReference } | { readonly reason: "absent" | "ambiguous" | "out_of_range" | "unsupported_boundary" } {
      const row = assertions.get(assertionId);
      if (row === undefined) throw new AlayaError("VALIDATION", "unknown source assertion");
      if (selection.text.length === 0) throw new AlayaError("VALIDATION", "source selection text must be non-empty");
      if (!selectionIndex.has(assertionId)) {
        // Charge two endpoint maps once for this assertion before allocating them.
        account(2 * row.segments.length, 160 * row.segments.length);
        const starts = new Map<number, string>();
        const ends = new Map<number, string>();
        let position = 0;
        for (const segment of row.segments) {
          starts.set(position, segment.id);
          position += segment.text.length;
          ends.set(position, segment.id);
        }
        selectionIndex.set(assertionId, { starts, ends });
      }
      const endpoints = selectionIndex.get(assertionId)!;
      let offset = 0;
      let rawMatch = false;
      let eligible = 0;
      let selected: SourceReference | undefined;
      while (offset <= row.text.length - selection.text.length) {
        const start = row.text.indexOf(selection.text, offset);
        if (start < 0) break;
        account(selection.text.length, 0);
        rawMatch = true;
        const first = endpoints.starts.get(start);
        const last = endpoints.ends.get(start + selection.text.length);
        if (first !== undefined && last !== undefined) {
          if (selection.occurrence === eligible) return { reference: { first, last } };
          if (selection.occurrence === undefined) {
            if (selected !== undefined) return { reason: "ambiguous" };
            selected = { first, last };
          }
          eligible += 1;
        }
        offset = start + 1;
      }
      if (selected !== undefined) return { reference: selected };
      if (!rawMatch) return { reason: "absent" };
      return { reason: eligible === 0 ? "unsupported_boundary" : "out_of_range" };
    }
  };
}
