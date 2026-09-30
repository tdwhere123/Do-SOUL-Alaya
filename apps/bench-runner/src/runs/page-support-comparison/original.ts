import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AlayaError, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SourceDeliveredSpanSchema, SourceDisclosureSchema,
  type SourceDeliveredSpan, type SourceDisclosure
} from "@do-soul/alaya-protocol";

export const PAGE_SUPPORT_COMPARISON_MAX_ORIGINS = SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET;

export const PageSupportOriginalSchema = z.object({
  text: z.string().min(1),
  source_disclosure: SourceDisclosureSchema,
  span: SourceDeliveredSpanSchema,
  preview_sha256: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict().superRefine((original, context) => {
  if (original.span.retained_extent !== "body") {
    context.addIssue({
      code: "custom", path: ["span", "retained_extent"],
      message: "page-support original requires body retained extent"
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

export type PageSupportOriginal = z.infer<typeof PageSupportOriginalSchema>;

export type PageSupportOriginalIdentity = Readonly<{
  preview_sha256: string;
  span: SourceDeliveredSpan;
  source_disclosure: SourceDisclosure;
}>;

const NativeResultSchema = z.object({
  content_preview: z.string().min(1),
  source_disclosure: SourceDisclosureSchema,
  target: z.object({ span: SourceDeliveredSpanSchema }).passthrough()
}).passthrough();

export function pageSupportOriginalIdentity(original: PageSupportOriginal): PageSupportOriginalIdentity {
  return {
    preview_sha256: original.preview_sha256,
    span: original.span,
    source_disclosure: original.source_disclosure
  };
}

export function assertPageSupportOriginal(original: PageSupportOriginal): void {
  const digest = createHash("sha256").update(original.text, "utf8").digest("hex");
  if (digest !== original.preview_sha256) {
    throw new AlayaError("VALIDATION", "page-support preview hash does not bind text");
  }
  const disclosure = original.source_disclosure;
  if (disclosure.material_kind !== "original_body" || disclosure.source_binding !== "checked_record" ||
      disclosure.proof_use.kind !== "source_only" ||
      disclosure.proof_use.qualification !== "not_current_proof") {
    throw new AlayaError("VALIDATION", "page-support source_disclosure is not a checked original");
  }
  if (original.span.retained_extent !== "body") {
    throw new AlayaError("VALIDATION", "page-support original requires body extent");
  }
  const previewBytes = Buffer.byteLength(original.text, "utf8");
  if (original.span.content_end - original.span.content_start !== previewBytes) {
    throw new AlayaError("VALIDATION", "page-support span is not the preview UTF-8 window");
  }
}

/** Anonymous original-text capture. Drops root identity, treatment, and later-page fields. */
export function capturePageSupportOriginal(input: unknown): PageSupportOriginal {
  const native = NativeResultSchema.safeParse(input);
  if (native.success) {
    return bindCapturedOriginal({
      text: native.data.content_preview,
      source_disclosure: native.data.source_disclosure,
      span: native.data.target.span,
      preview_sha256: createHash("sha256").update(native.data.content_preview, "utf8").digest("hex")
    });
  }
  return bindCapturedOriginal(PageSupportOriginalSchema.parse(input));
}

export function capturePageSupportArm(rows: readonly unknown[]): readonly PageSupportOriginal[] {
  if (rows.length > PAGE_SUPPORT_COMPARISON_MAX_ORIGINS) {
    throw new AlayaError("VALIDATION", "page-support arm exceeds the five-source page");
  }
  return Object.freeze(rows.map((row) => capturePageSupportOriginal(row)));
}

export function pageSupportQuoteOccurrences(
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

function bindCapturedOriginal(original: PageSupportOriginal): PageSupportOriginal {
  const parsed = PageSupportOriginalSchema.parse(original);
  assertPageSupportOriginal(parsed);
  return Object.freeze(structuredClone(parsed));
}
