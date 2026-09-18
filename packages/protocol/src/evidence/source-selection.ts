import { z } from "zod";
import { PositiveIntSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";

export const SourceAssertionIdSchema = PositiveIntSchema;
// Occurrences are zero-based. Omission policy belongs to the versioned consumer.
export const SourceOccurrenceSchema = NonNegativeIntSchema.lt(128);
export const SourceTextSpanSchema = z.tuple([
  NonNegativeIntSchema, PositiveIntSchema
]).refine(([start, end]) => end > start, "source span must be non-empty").readonly();

// Source text spans use JavaScript UTF-16 offsets, as do the assertion catalog
// and grounded graphs. Durable source UTF-8 byte ranges are a separate contract.
export function findSourceTextOccurrence(
  source: string, text: string, occurrence: number
): readonly [number, number] | null {
  if (text.length === 0 || !Number.isInteger(occurrence) || occurrence < 0) return null;
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const start = source.indexOf(text, offset);
    if (start < 0) return null;
    if (index === occurrence) return Object.freeze([start, start + text.length]);
    offset = start + text.length;
  }
  return null;
}

/** Strict proposal selection: a repeated quotation requires an explicit occurrence. */
export function locateSourceTextSelection(source: string, selection: Readonly<{ text: string; occurrence?: number }>):
  { readonly span: readonly [number, number] } | { readonly reason: "absent" | "ambiguous" | "out_of_range" } {
  if (findSourceTextOccurrence(source, selection.text, 0) === null) return { reason: "absent" };
  if (selection.occurrence === undefined && findSourceTextOccurrence(source, selection.text, 1) !== null) {
    return { reason: "ambiguous" };
  }
  const span = findSourceTextOccurrence(source, selection.text, selection.occurrence ?? 0);
  return span === null ? { reason: "out_of_range" } : { span };
}
