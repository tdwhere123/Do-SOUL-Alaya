import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  binding: Object.freeze({
    kind: "longmemeval-source-assertion-semantic-supplement" as const,
    receipt_sha256: "1".repeat(64),
    entry_count: 1,
    assertion_count: 1,
    occurrence_count: 1,
    entry_set_sha256: "2".repeat(64),
    primary_manifest_sha256: "3".repeat(64),
    source_manifest_sha256: "4".repeat(64),
    parser_semantics: "official-api-signal-parser-v8",
    grounding_semantics: "official-api-source-grounding-v2"
  })
}));

vi.mock(
  "../../../longmemeval/extraction/cache/semantic-supplement/" +
    "source-assertion-supplement-runtime.js",
  () => ({ createSourceAssertionSupplementRuntime: fixture.createRuntime })
);

import { createCompileSeedRunner } from "../../../longmemeval/compile-seed.js";

describe("semantic supplement run authority", () => {
  it("is fixed when the runner is created, before any turn is seeded", () => {
    fixture.createRuntime.mockReturnValue({
      receipt: Object.freeze({}),
      binding: fixture.binding,
      beginTurn: vi.fn(),
      compile: vi.fn(),
      mergeTurnStats: vi.fn()
    });

    const runner = createCompileSeedRunner({
      cacheRoot: "/tmp/semantic-supplement-authority-primary",
      config: {
        providerUrl: "https://example.test/v1",
        model: "same-logical-model",
        requestProfile: "provider-default-v1",
        apiKey: null
      },
      skipPreflight: true,
      diagnosticDir: null,
      sourceAssertionSupplement: {
        receiptPath: "/tmp/semantic-supplement-authority-receipt.json",
        sourceCacheRoot: "/tmp/semantic-supplement-authority-source"
      }
    });

    expect(runner.semanticSupplementBinding).toBe(fixture.binding);
    expect(runner.stats).not.toHaveProperty("semanticSupplementBinding");
  });
});
