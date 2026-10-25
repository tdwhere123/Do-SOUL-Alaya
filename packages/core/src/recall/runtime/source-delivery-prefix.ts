import type { SourceDeliveryBoundaries } from "@do-soul/alaya-protocol";

/** Core owns the delivery unit order. Storage supplies recorded span facts only.
 * The message purpose is produced by host-occurrence admission, never inferred.
 * Choosing the unit precedes fitting: an oversized message cannot become a line.
 */
export function sourceDeliveryEnds(boundaries: SourceDeliveryBoundaries | undefined, start = 0): readonly number[] | undefined {
  if (boundaries?.status !== "available") return undefined;
  const unit = boundaries.spans.some(span => ["message"].includes(span.purpose)) ? "message" : "line";
  return boundaries.spans.filter(span => span.purpose === unit).map(span => span.end_offset - start);
}

/** Fit a literal source prefix, then prefer the largest recorded structural end.
 * Ends are relative to this text's source start and already belong to the single
 * coarsest available unit. The caller owns source authority and lookup accounting.
 * Undefined means unavailable; an empty set means a successful lookup found none.
 */
export function sourceDeliveryPrefix(text: string, fits: (prefix: string) => boolean,
  recordedEnds?: readonly number[]): string {
  let low = 0, high = text.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, end))) low = end;
    else high = end - 1;
  }
  // Never expose half a surrogate pair when converting the fitted prefix to UTF-8.
  if (low > 0 && low < text.length && /[\uD800-\uDBFF]/u.test(text[low - 1]!)
    && /[\uDC00-\uDFFF]/u.test(text[low]!)) low -= 1;
  const prefix = text.slice(0, low);
  if (recordedEnds === undefined || recordedEnds.length === 0) return prefix;
  const bytes = Buffer.from(prefix);
  let alignedEnd = 0;
  for (const end of recordedEnds) {
    if (Number.isSafeInteger(end) && end > alignedEnd && end <= bytes.length
      && (end === bytes.length || (bytes[end]! & 0xc0) !== 0x80)) alignedEnd = end;
  }
  return alignedEnd === 0 ? prefix : bytes.subarray(0, alignedEnd).toString("utf8");
}
