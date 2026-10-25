import { hydrateUtf8Chunk } from "@do-soul/alaya-core";
import { AlayaError, canonicalJson, sourceGoldRootIdentity } from "@do-soul/alaya-protocol";
import type { SourceGoldUnit } from "../../measurement/source-gold-join.js";
import type { ConsumerVisibilityInterval, ConsumerVisibilityPage, ConsumerVisibilityUnmappedSource }
  from "../../longmemeval-semantic/message-visibility.js";

/** Observed source display bytes are not necessarily literal source bytes. Rank includes
 * all occupied results; text is always the actual displayed preview, including decoration. */
export type OrdinarySourcePreview = Readonly<{
  rank: number; target: SourceGoldUnit; text: string;
  source: Readonly<{ status: "literal"; start: number; end: number }>
    | Readonly<{ status: "unmapped"; reason: string }>
    | Readonly<{ status: "not_delivered"; reason: string }>;
}>;
export type OrdinaryLiteralWindow = ConsumerVisibilityInterval & Readonly<{ text: string }>;

export function ordinaryLiteralWindows(previews: readonly OrdinarySourcePreview[]): OrdinaryLiteralWindow[] {
  return previews.flatMap(preview => preview.source.status === "literal" ? [{ rank: preview.rank,
    target: preview.target, text: preview.text, start: preview.source.start, end: preview.source.end }] : []);
}
export function ordinaryUnmappedSources(previews: readonly OrdinarySourcePreview[]): ConsumerVisibilityUnmappedSource[] {
  return previews.flatMap(preview => preview.source.status === "unmapped" ? [{ rank: preview.rank, target: preview.target }] : []);
}
export function ordinaryPreviewStreamIssue(previews: readonly OrdinarySourcePreview[] | undefined,
  pages: readonly ConsumerVisibilityPage[] | undefined): string | null {
  if (previews === undefined) return "ordinary_preview_stream_unbound";
  const observed = (pages ?? []).filter(page => page.status === "observed");
  const windows = ordinaryLiteralWindows(previews), unknown = ordinaryUnmappedSources(previews);
  const roots = previews.map(preview => sourceGoldRootIdentity({ ...preview.target, kind: "source_evidence", evidence_object_id: null }));
  if (new Set(roots).size !== roots.length || previews.some((preview, i) =>
    !Number.isSafeInteger(preview.rank) || preview.rank <= (previews[i - 1]?.rank ?? 0)
    || Buffer.from(preview.text).toString("utf8") !== preview.text
    || !["literal", "unmapped", "not_delivered"].includes(preview.source.status))
    || windows.some(window => window.start < 0 || !Number.isSafeInteger(window.start)
      || window.end - window.start !== Buffer.byteLength(window.text))
    || canonicalJson(windows.map(({ text: _text, ...interval }) => interval)) !== canonicalJson(observed.flatMap(page => page.intervals))
    || canonicalJson(unknown) !== canonicalJson(observed.flatMap(page => page.unmapped_sources ?? []))) return "ordinary_preview_stream_not_bound";
  let occupied = 0;
  const ranges = (pages ?? []).map(page => {
    const start = occupied + 1; occupied += page.occupied_slots;
    return { observed: page.status === "observed", start, end: occupied };
  });
  return previews.every(preview => ranges.some(range => range.observed && preview.rank >= range.start
    && preview.rank <= range.end)) ? null : "ordinary_preview_stream_not_bound";
}

/** Clip displayed UTF-8, never infer a source offset for unmapped text. */
export function clipOrdinaryPreview(preview: OrdinarySourcePreview, budget: number): OrdinarySourcePreview {
  const chunk = hydrateUtf8Chunk(preview.text, { byteLimit: budget });
  const text = chunk.status === "chunk" ? chunk.text : "";
  return { ...preview, text, source: preview.source.status === "literal"
    ? { ...preview.source, end: preview.source.start + Buffer.byteLength(text) } : preview.source };
}
export function ordinaryBodyStreamUnavailableReason(previews: readonly OrdinarySourcePreview[]): string | null {
  return previews.some(preview => preview.source.status === "unmapped") ? "ordinary_source_body_stream_mapping_unavailable" : null;
}
/** B is source-body bytes, never decoration or other display bytes. An unmapped
 * display cannot silently disappear from cumulative body-offset accounting. */
export function prefixOrdinaryBodyPreviews(previews: readonly OrdinarySourcePreview[], budget: number): OrdinarySourcePreview[] {
  if (ordinaryBodyStreamUnavailableReason(previews) !== null) throw new AlayaError("UNAVAILABLE", "source-body stream mapping unavailable");
  const packed: OrdinarySourcePreview[] = [];
  let remaining = budget;
  for (const preview of previews) {
    if (preview.source.status === "not_delivered") continue;
    if (remaining === 0) break;
    const size = Buffer.byteLength(preview.text);
    if (size <= remaining) { packed.push(preview); remaining -= size; continue; }
    const clipped = clipOrdinaryPreview(preview, remaining);
    if (clipped.text.length > 0) packed.push(clipped);
    break;
  }
  return packed;
}
