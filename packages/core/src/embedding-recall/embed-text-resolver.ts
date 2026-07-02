import type { MemoryEntry } from "@do-soul/alaya-protocol";

// d2q vectors live in their own cosine space; the bump makes non-d2q rows look
// stale (freshness re-embeds them) and keeps the two spaces from being mixed.
export const D2Q_SCHEMA_VERSION = 2;
export const D2Q_EMBED_TEXT_MAX_CHARS = 1200;

// Doc2query HQ source: hypothetical questions a memory can answer, keyed by the
// memory object id. Absent ids contribute no HQ (embed text stays raw content).
export interface HqProvider {
  getHqByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly string[]>>;
}

// off / no HQ → raw content, byte-identical to the non-d2q embed path.
export function resolveEmbedText(
  memory: Readonly<Pick<MemoryEntry, "content">>,
  hqs: readonly string[]
): string {
  if (hqs.length === 0) {
    return memory.content;
  }
  return `${memory.content} ${hqs.join(" ")}`.slice(0, D2Q_EMBED_TEXT_MAX_CHARS);
}
