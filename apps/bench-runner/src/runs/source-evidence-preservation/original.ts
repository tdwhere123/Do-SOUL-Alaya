import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AlayaError, FieldContractDigestSchema, SourceDeliveredSpanSchema, SourceDisclosureSchema,
  type SourceDeliveredSpan, type SourceDisclosure
} from "@do-soul/alaya-protocol";

export const SourceEvidencePreservationOriginalSchema = z.object({
  root_id: z.string().min(1).max(256),
  source_version: z.string().min(1).max(256),
  content_digest: FieldContractDigestSchema,
  span: SourceDeliveredSpanSchema,
  preview_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  source_disclosure: SourceDisclosureSchema,
  text: z.string().min(1)
}).strict().superRefine((original, context) => {
  if (original.span.retained_extent !== "body") {
    context.addIssue({
      code: "custom", path: ["span", "retained_extent"],
      message: "original_body requires body retained extent"
    });
  }
  const previewBytes = Buffer.byteLength(original.text, "utf8");
  if (original.span.content_end - original.span.content_start !== previewBytes) {
    context.addIssue({
      code: "custom", path: ["span"],
      message: "delivered span must cover the preview UTF-8 bytes"
    });
  }
});

export type SourceEvidencePreservationOriginal = z.infer<typeof SourceEvidencePreservationOriginalSchema>;

export type SourceEvidencePreservationIdentity = Readonly<{
  root_id: string;
  source_version: string;
  content_digest: string;
  preview_sha256: string;
  span: SourceDeliveredSpan;
  source_disclosure: SourceDisclosure;
}>;

export function sourceEvidencePreservationIdentity(
  original: SourceEvidencePreservationOriginal
): SourceEvidencePreservationIdentity {
  return {
    root_id: original.root_id,
    source_version: original.source_version,
    content_digest: original.content_digest,
    preview_sha256: original.preview_sha256,
    span: original.span,
    source_disclosure: original.source_disclosure
  };
}

export function assertSourceEvidencePreservationOriginal(
  original: SourceEvidencePreservationOriginal
): void {
  const digest = createHash("sha256").update(original.text, "utf8").digest("hex");
  if (digest !== original.preview_sha256) {
    throw new AlayaError("VALIDATION", `preservation preview hash does not bind text: ${original.root_id}`);
  }
  const disclosure = original.source_disclosure;
  if (disclosure.material_kind !== "original_body" || disclosure.source_binding !== "checked_record" ||
      disclosure.proof_use.kind !== "source_only") {
    throw new AlayaError("VALIDATION", `preservation source_disclosure is not a checked original: ${original.root_id}`);
  }
  if (original.span.retained_extent !== "body") {
    throw new AlayaError("VALIDATION", `preservation original requires body extent: ${original.root_id}`);
  }
  const previewBytes = Buffer.byteLength(original.text, "utf8");
  if (original.span.content_end - original.span.content_start !== previewBytes) {
    throw new AlayaError("VALIDATION", `preservation span is not the preview UTF-8 window: ${original.root_id}`);
  }
}

export function sourceEvidencePreservationQuoteOccurrences(
  text: string, quote: string, contentStart: number
): readonly { readonly start: number; readonly end: number }[] {
  if (quote.length === 0) return [];
  const haystack = Buffer.from(text, "utf8");
  const needle = Buffer.from(quote, "utf8");
  const occurrences: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    occurrences.push({ start: contentStart + index, end: contentStart + index + needle.length });
    from = index + 1;
  }
  return occurrences;
}
