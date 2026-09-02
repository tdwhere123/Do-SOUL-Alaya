import { describe, expect, it } from "vitest";
import {
  planOfficialApiSemanticWorkset,
  planOfficialApiTransport
} from "../../../garden/ingestion/official-api/semantic-workset.js";
import {
  buildOfficialApiExtractionRequests as buildLegacyRequests,
  stringifyOfficialApiExtractionRequest as stringifyLegacy
} from "../../../garden/ingestion/official-api/extraction-request.js";

describe("official API semantic workset", () => {
  const turn = Array.from({ length: 20 }, (_, index) =>
    `I recorded fact number ${index + 1} about Berlin.`
  ).join(" ");
  const messages = [{ role: "user" as const, content: turn }];

  it("keeps assertion semantic keys identical across 8/16/24/32 packing", () => {
    const workset = planOfficialApiSemanticWorkset(turn, messages);
    expect(workset.units.length).toBeGreaterThan(0);
    const keys = workset.units.map((unit) => unit.semanticKey).sort();
    for (const size of [8, 16, 24, 32] as const) {
      const packed = planOfficialApiTransport(workset, {
        kind: "reference_batch",
        assertionsPerPack: size
      });
      const packedKeys = packed.packs.flatMap((pack) => [...pack.semantic_keys]).sort();
      expect(packedKeys).toEqual(keys);
      expect(packed.packs.every((pack) => pack.semantic_keys.length <= size)).toBe(true);
    }
    expect(stringifyLegacy(buildLegacyRequests(turn, messages)[0]!))
      .not.toContain(workset.units[0]!.semanticKey);
  });

  it("does not put workset identity into the legacy batch=8 request JSON", () => {
    const workset = planOfficialApiSemanticWorkset("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]);
    const legacy = buildLegacyRequests("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]);
    expect(JSON.stringify(legacy)).not.toContain(workset.workset_digest);
    expect(workset.units.map((unit) => unit.semanticKey).sort().join()).toBe(
      [...new Set(workset.units.map((unit) => unit.semanticKey))].sort().join()
    );
  });
});
