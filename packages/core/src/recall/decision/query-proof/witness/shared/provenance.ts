import {
  freezeShadow,
  requireNonemptyString,
  ShadowContractError
} from "../../../prefix-capture/envelope.js";
import type { WitnessProvenanceEntry } from "./types.js";

export function parseProvenance(
  entries: readonly WitnessProvenanceEntry[]
): readonly WitnessProvenanceEntry[] {
  if (!Array.isArray(entries)) {
    throw new ShadowContractError("provenance must be a list");
  }
  return freezeProvenance(entries.map(parseProvenanceEntry));
}

export function parseProvenanceEntry(
  entry: WitnessProvenanceEntry
): WitnessProvenanceEntry {
  return freezeShadow({
    source_id: requireNonemptyString(entry.source_id, "source_id"),
    producer: requireNonemptyString(entry.producer, "producer")
  });
}

export function freezeProvenance(
  entries: readonly WitnessProvenanceEntry[]
): readonly WitnessProvenanceEntry[] {
  return Object.freeze(entries.map((entry) => parseProvenanceEntry(entry)));
}

export function extendProvenance(
  from: readonly WitnessProvenanceEntry[],
  to: readonly WitnessProvenanceEntry[]
): readonly WitnessProvenanceEntry[] {
  const toKeys = new Set(to.map(entryKey));
  for (const entry of from) {
    assertPreserved(entry, to, toKeys);
  }
  return unionProvenance(from, to);
}

export function unionProvenance(
  left: readonly WitnessProvenanceEntry[],
  right: readonly WitnessProvenanceEntry[]
): readonly WitnessProvenanceEntry[] {
  const seen = new Set<string>();
  const merged: WitnessProvenanceEntry[] = [];
  for (const entry of [...left, ...right]) {
    const parsed = parseProvenanceEntry(entry);
    assertNoReplacement(parsed, merged);
    const key = entryKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(parsed);
  }
  return Object.freeze(merged);
}

export function entryKey(entry: WitnessProvenanceEntry): string {
  return `${entry.source_id}\0${entry.producer}`;
}

function assertPreserved(
  entry: WitnessProvenanceEntry,
  to: readonly WitnessProvenanceEntry[],
  toKeys: ReadonlySet<string>
): void {
  if (toKeys.has(entryKey(entry))) return;
  if (to.some((candidate) => candidate.source_id === entry.source_id)) {
    throw new ShadowContractError("provenance replacement is illegal");
  }
  throw new ShadowContractError("provenance loss is illegal refinement");
}

function assertNoReplacement(
  incoming: WitnessProvenanceEntry,
  existing: readonly WitnessProvenanceEntry[]
): void {
  const clash = existing.find((entry) =>
    entry.source_id === incoming.source_id && entry.producer !== incoming.producer);
  if (clash !== undefined) {
    throw new ShadowContractError("provenance replacement is illegal");
  }
}
