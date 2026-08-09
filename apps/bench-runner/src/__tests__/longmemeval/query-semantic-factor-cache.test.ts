import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import { OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID } from "@do-soul/alaya-soul";
import {
  createQuerySemanticFactorCache,
  readQuerySemanticFactorCache,
  writeQuerySemanticFactorCache
} from "../../longmemeval/query-factors/query-semantic-factor-cache.js";

describe("query semantic factor cache", () => {
  it("replays a source-bound formation capture without provider configuration", async () => {
    const sourceText = "What do I use?";
    const capture = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: sourceText,
      proposal: {
        schema_version: 1,
        producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
        source_text: sourceText,
        graph: {
          schema_version: 1,
          source_kind: "query",
          factors: [
            factor("actor", "I", "i"),
            factor("predicate", "use", "use")
          ],
          variables: [{ variable_id: "answer", surface: "What" }],
          result_variable_ids: ["answer"],
          propositions: [{
            proposition_id: "use-query",
            predicate_factor_id: "predicate",
            arguments: [
              argument(0, "factor", "actor", "agent"),
              argument(1, "variable", "answer", "object")
            ]
          }]
        }
      }
    });
    expect(capture.status).toBe("formed");
    const cache = createQuerySemanticFactorCache({
      model_id: "test-model",
      provider_url: "https://provider.invalid/v1",
      entries: [{
        source_text: sourceText,
        source_sha256: capture.source_sha256!,
        capture
      }]
    });
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-cache-"));
    const outputPath = join(root, "query-cache.json");
    try {
      await writeQuerySemanticFactorCache(outputPath, cache);
      const loaded = await readQuerySemanticFactorCache({
        path: outputPath,
        required_source_texts: [sourceText]
      });

      expect(loaded.binding.entry_count).toBe(1);
      expect(loaded.captures_by_source_text.get(sourceText)).toEqual(capture);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a cache that does not close the requested query source set", async () => {
    const capture = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "What do I use?"
    });
    const cache = createQuerySemanticFactorCache({
      model_id: "test-model",
      provider_url: "https://provider.invalid/v1",
      entries: [{
        source_text: "What do I use?",
        source_sha256: capture.source_sha256!,
        capture
      }]
    });
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-cache-"));
    const outputPath = join(root, "query-cache.json");
    try {
      await writeQuerySemanticFactorCache(outputPath, cache);
      await expect(readQuerySemanticFactorCache({
        path: outputPath,
        required_source_texts: ["What do I buy?"]
      })).rejects.toThrow("missing a required query source");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
}

function argument(
  position: number,
  referenceKind: "factor" | "variable",
  referenceId: string,
  bindingIdentity: string
) {
  return {
    position,
    reference_kind: referenceKind,
    reference_id: referenceId,
    binding_identity: bindingIdentity
  };
}
