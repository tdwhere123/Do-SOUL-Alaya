import { describe, expect, it, vi } from "vitest";
import { buildSourceReferenceCatalog } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  publishAdmittedSourceSemanticInterpretation, verifyRequestOwnedLocations
} from "../../../../runs/extraction/cache/source-semantic-runtime-publish.js";

const SOURCE = "I like coffee. I like coffee.";
const SENTENCE = "I like coffee.";
const FIRST: readonly [number, number] = [0, Buffer.byteLength(SENTENCE)];
const SECOND: readonly [number, number] = [
  Buffer.byteLength(SENTENCE) + 1, Buffer.byteLength(SOURCE)
];

function catalogFor(source = SOURCE) {
  return buildSourceReferenceCatalog(fieldContractSha256(source), [
    { assertion_id: 1, text: SENTENCE }, { assertion_id: 2, text: SENTENCE }
  ], fieldContractSha256);
}

describe("source semantic runtime publication adapter", () => {
  it("forwards request-owned locations and does not publish a digest mismatch", async () => {
    const publish = vi.fn(async (_input: { assertion_locations?: unknown; interpretation?: unknown }) => ({
      bound: { interpretation_id: "published" }, evidence: { object_id: "evidence" }
    } as Awaited<ReturnType<typeof publishAdmittedSourceSemanticInterpretation>>));
    const catalog = catalogFor();
    const locations = [
      { assertion_id: 1, source_utf8_span: FIRST },
      { assertion_id: 2, source_utf8_span: SECOND }
    ];
    await publishAdmittedSourceSemanticInterpretation({
      publication: { publish }, workspaceId: "ws", runId: "run", artifactKey: "source-1",
      source: SOURCE, catalog, interpretation: { source: { assertion_locations: locations } } as never,
      producer_id: "official-api-source-semantic", producer_version: "1",
      contract_version: "source-interpretation-v4", assertion_locations: locations
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      artifactKey: "source-1", assertion_locations: locations, interpretation: expect.anything()
    }));
    await expect(publishAdmittedSourceSemanticInterpretation({
      publication: { publish }, workspaceId: "ws", runId: "run", artifactKey: "source-1",
      source: SOURCE, catalog: catalogFor("other source text"),
      interpretation: { source: {} } as never, producer_id: "official-api-source-semantic",
      producer_version: "1", contract_version: "source-interpretation-v4", assertion_locations: locations
    })).rejects.toThrow(/source digest differs from the request catalog/);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("rejects a draft together with a normalized interpretation", async () => {
    const publish = vi.fn();
    await expect(publishAdmittedSourceSemanticInterpretation({
      publication: { publish }, workspaceId: "ws", runId: "run", artifactKey: "source-1",
      source: SOURCE, catalog: catalogFor(), interpretation: { source: {} } as never, draft: { contract: "x" },
      producer_id: "official-api-source-semantic", producer_version: "1",
      contract_version: "source-interpretation-v4", assertion_locations: [
        { assertion_id: 1, source_utf8_span: FIRST }, { assertion_id: 2, source_utf8_span: SECOND }
      ]
    })).rejects.toThrow(/draft or a normalized interpretation, not both/);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects a location that does not match the catalog text", () => {
    const catalog = catalogFor();
    expect(() => verifyRequestOwnedLocations(SOURCE, catalog, [
      { assertion_id: 1, source_utf8_span: FIRST },
      { assertion_id: 2, source_utf8_span: [0, 4] }
    ])).toThrow(/assertion location differs from source text/);
    expect(verifyRequestOwnedLocations(SOURCE, catalog, [
      { assertion_id: 1, source_utf8_span: FIRST },
      { assertion_id: 2, source_utf8_span: SECOND }
    ])).toEqual([
      { assertion_id: 1, source_utf8_span: FIRST },
      { assertion_id: 2, source_utf8_span: SECOND }
    ]);
  });
});
