import { normalizeMemoryObjectKeySurface, type MemoryObjectKey } from "@do-soul/alaya-protocol";
import { occupancySet } from "./occupancy.js";
import { mintGistRemainderKeys } from "./gist-remainder.js";
import { mintNumericAliasKeys } from "./numeric-aliases.js";
import { mintTemporalAliasKeys } from "./temporal-aliases.js";
import type { MintMemoryObjectKeysInput } from "../types.js";

export function mintMemoryObjectKeys(
  input: Readonly<MintMemoryObjectKeysInput>
): readonly Readonly<MemoryObjectKey>[] {
  const occupied = new Set(occupancySet(input.memory_content));
  const minted: MemoryObjectKey[] = [];
  for (const evidence of input.evidence) {
    acceptKeys(minted, occupied, mintGistRemainderKeys({ ...input, evidence, occupied }));
  }
  acceptKeys(minted, occupied, mintTemporalAliasKeys({ ...input, occupied }));
  acceptKeys(minted, occupied, mintNumericAliasKeys({ ...input, occupied }));
  return Object.freeze(minted);
}

function acceptKeys(
  minted: MemoryObjectKey[],
  occupied: Set<string>,
  keys: readonly Readonly<MemoryObjectKey>[]
): void {
  for (const key of keys) {
    const normalized = normalizeMemoryObjectKeySurface(key.surface);
    if (occupied.has(normalized)) continue;
    occupied.add(normalized);
    minted.push(key);
  }
}
