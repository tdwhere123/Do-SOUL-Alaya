import { normalizeMemoryObjectKeySurface } from "@do-soul/alaya-protocol";
import { tokenizeWithSpans } from "../normalize/tokenize.js";

export function occupancySet(
  memoryContent: string,
  factKeyContents: readonly string[]
): ReadonlySet<string> {
  const occupied = new Set<string>();
  addTextOccupancy(occupied, memoryContent);
  for (const fact of factKeyContents) addTextOccupancy(occupied, fact);
  return occupied;
}

export function occupies(
  surface: string,
  occupied: ReadonlySet<string>,
  contentNormalized: string
): boolean {
  const normalized = normalizeMemoryObjectKeySurface(surface);
  if (normalized.length === 0 || occupied.has(normalized)) return true;
  return normalized.length >= 4 && contentNormalized.includes(normalized);
}

function addTextOccupancy(occupied: Set<string>, text: string): void {
  const normalized = normalizeMemoryObjectKeySurface(text);
  if (normalized.length > 0) occupied.add(normalized);
  for (const span of tokenizeWithSpans(text)) {
    const token = normalizeMemoryObjectKeySurface(span.token);
    if (token.length > 0) occupied.add(token);
  }
}
