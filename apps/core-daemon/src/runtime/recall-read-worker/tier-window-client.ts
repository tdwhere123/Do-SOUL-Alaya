import type { RecallServiceMemoryRepoPort } from "@do-soul/alaya-core";

const RECALL_TIER_WINDOW_CHUNK_KIND = "recall-tier-window-chunk";

type TierWindowReader = NonNullable<RecallServiceMemoryRepoPort["findRecallTierWindow"]>;
type TierWindowResult = Awaited<ReturnType<TierWindowReader>>;

export type TierWindowChunkConsumption = Readonly<
  | { readonly done: false }
  | { readonly done: true; readonly value: TierWindowResult }
>;

export function createTierWindowChunkConsumer(): (
  value: unknown
) => TierWindowChunkConsumption {
  const memories: TierWindowResult["memories"][number][] = [];
  return (value) => {
    const chunk = parseTierWindowChunk(value);
    memories.push(...chunk.memories);
    if (!chunk.done) return Object.freeze({ done: false });
    return Object.freeze({
      done: true,
      value: Object.freeze({
        memories: Object.freeze(memories),
        next_cursor: chunk.next_cursor,
        truncated: chunk.truncated
      })
    });
  };
}

function parseTierWindowChunk(value: unknown): TierWindowChunk {
  if (!isRecord(value) || value.kind !== RECALL_TIER_WINDOW_CHUNK_KIND) {
    throw new Error("invalid recall tier window chunk");
  }
  if (!Array.isArray(value.memories) || typeof value.done !== "boolean") {
    throw new Error("invalid recall tier window chunk payload");
  }
  if (typeof value.truncated !== "boolean") {
    throw new Error("invalid recall tier window chunk terminal state");
  }
  return value as TierWindowChunk;
}

type TierWindowChunk = Readonly<{
  readonly kind: typeof RECALL_TIER_WINDOW_CHUNK_KIND;
  readonly memories: TierWindowResult["memories"];
  readonly next_cursor: TierWindowResult["next_cursor"];
  readonly truncated: boolean;
  readonly done: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
