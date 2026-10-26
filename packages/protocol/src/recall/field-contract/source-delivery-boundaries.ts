import type { AddressableSourceSpan } from "./source-span.js";

/** Recorded source facts for literal delivery only, never semantic support.
 * Available with no spans is known absence; an unreadable or bounded-out lookup
 * must not be cached as that successful empty result. Offsets are absolute UTF-8.
 * Spans cover one unit's ends inside the hydrated window, not the whole root.
 */
export type SourceDeliveryBoundaries = Readonly<
  | { status: "available"; spans: readonly Pick<AddressableSourceSpan, "purpose" | "end_offset">[] }
  | { status: "unavailable"; reason: "unreadable" | "resource_limited" }
>;
