import { afterEach, describe, expect, it } from "vitest";
import { sourceEvidenceRootKey, type InformationIndex } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import {
  identitySet,
  plantSource,
  recallPlantedSource
} from "../../conditional-field-oracle/cp11-planted-source.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("source preview identity", () => {
  it("keeps the same product identity set across nativeByteLimit and preview sizes", () => {
    const { reader } = plantSource((database) => databases.add(database), [
      { body: `NEEDLE ${"x".repeat(8000)}` }
    ]);
    const compact = recallPlantedSource(reader, "NEEDLE", 16_384, 128);
    const wide = recallPlantedSource(reader, "NEEDLE", 65_536, 4_096);
    const compactIds = identitySet(compact);
    expect(compactIds.length).toBeGreaterThan(0);
    expect(compactIds).toEqual(identitySet(wide));
    expect(rootSet(compact)).toEqual(rootSet(wide));
    expect(spans(compact)).not.toEqual(spans(wide));
  });
});

function rootSet(index: InformationIndex): string[] {
  return index.entries
    .filter((entry) => entry.target.kind === "source_evidence")
    .map((entry) => entry.target.kind === "source_evidence" ? sourceEvidenceRootKey(entry.target) : "")
    .sort();
}

function spans(index: InformationIndex) {
  return index.entries.map((entry) =>
    entry.target.kind === "source_evidence" ? entry.target.span : undefined
  );
}
