import type { AddressableSourceSpan } from "./source-span.js";

/** Recorded source facts for literal delivery only, never semantic support.
 * Available with no spans or first end is known absence in the window; an unreadable or bounded-out lookup
 * must not be cached as that successful empty result. Offsets are absolute UTF-8.
 * Spans cover one unit's ends inside the hydrated window, not the whole root;
 * an optional first end can name an oversized unit beyond that window.
 */
export type SourceDeliveryBoundaries = Readonly<
  | { status: "available"; spans: readonly Pick<AddressableSourceSpan, "purpose" | "end_offset">[];
      /** First recorded unit end beyond the hydrated window, read without its body. */
      first_end_offset?: number }
  | { status: "unavailable"; reason: "unreadable" | "resource_limited" }
>;
