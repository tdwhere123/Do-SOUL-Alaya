import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeOpenSemanticFactorFormation,
  stableStringify
} from "@do-soul/alaya-core";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE
} from "@do-soul/alaya-soul";
import {
  createQuerySemanticFactorCache,
  fillQuerySemanticFactorSources,
  readQuerySemanticFactorCache,
  writeQuerySemanticFactorCache
} from "../../bench/query-factors/query-semantic-factor-cache.js";

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
          schema_version: 2,
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
      expect(loaded.binding.compiler_operator_id)
        .toBe("open_semantic_factor_query_compiler_v5");
      expect(loaded.binding.request_template_sha256)
        .toBe(prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE));
      expect(loaded.captures_by_source_text.get(sourceText)).toEqual(capture);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an honestly resealed legacy v4 compiler cache", async () => {
    const sourceText = "What do I use?";
    const capture = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: sourceText
    });
    const cache = createQuerySemanticFactorCache({
      model_id: "test-model",
      provider_url: "https://provider.invalid/v1",
      entries: [{
        source_text: sourceText,
        source_sha256: capture.source_sha256!,
        capture
      }]
    });
    const legacy = resealLegacyV4(cache);
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-cache-"));
    const outputPath = join(root, "query-cache.json");
    try {
      await writeFile(outputPath, JSON.stringify(legacy), "utf8");
      await expect(readQuerySemanticFactorCache({
        path: outputPath,
        required_source_texts: [sourceText]
      })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an honestly resealed prior request template", async () => {
    const sourceText = "What do I use?";
    const capture = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: sourceText
    });
    const cache = createQuerySemanticFactorCache({
      model_id: "test-model",
      provider_url: "https://provider.invalid/v1",
      entries: [{
        source_text: sourceText,
        source_sha256: capture.source_sha256!,
        capture
      }]
    });
    const prior = resealPriorRequestTemplate(cache);
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-cache-"));
    const outputPath = join(root, "query-cache.json");
    try {
      await writeFile(outputPath, JSON.stringify(prior), "utf8");
      await expect(readQuerySemanticFactorCache({
        path: outputPath,
        required_source_texts: [sourceText]
      })).rejects.toThrow("request template does not match");
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

  it("resumes successful sources through a same-model transport switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-fill-"));
    const outputPath = join(root, "query-cache.json");
    const firstCompile = async (sourceText: string) => {
      if (sourceText === "Beta?") throw new Error("primary transport unavailable");
      return null;
    };
    const firstCalls: string[] = [];
    try {
      await expect(fillQuerySemanticFactorSources({
        source_texts: ["Alpha?", "Beta?", "Gamma?"],
        output_path: outputPath,
        model_id: "same-model",
        provider_url: "https://logical-provider.invalid/v1",
        transport: {
          providerUrl: "https://primary.invalid/v1",
          model: "same-model"
        },
        concurrency: 1,
        compile: async (sourceText) => {
          firstCalls.push(sourceText);
          return await firstCompile(sourceText);
        }
      })).rejects.toThrow(/primary transport unavailable/u);
      expect(firstCalls).toEqual(["Alpha?", "Beta?"]);

      const driftedCalls: string[] = [];
      await expect(fillQuerySemanticFactorSources({
        source_texts: ["Alpha?", "Beta?", "Gamma?"],
        output_path: outputPath,
        model_id: "different-model",
        provider_url: "https://logical-provider.invalid/v1",
        transport: {
          providerUrl: "https://successor.invalid/v1",
          model: "different-model"
        },
        concurrency: 1,
        compile: async (sourceText) => {
          driftedCalls.push(sourceText);
          return null;
        }
      })).rejects.toThrow(/partial cache identity mismatch/u);
      expect(driftedCalls).toEqual([]);

      const successorCalls: string[] = [];
      const binding = await fillQuerySemanticFactorSources({
        source_texts: ["Alpha?", "Beta?", "Gamma?"],
        output_path: outputPath,
        model_id: "same-model",
        provider_url: "https://logical-provider.invalid/v1",
        transport: {
          providerUrl: "https://successor.invalid/v1",
          model: "same-model"
        },
        concurrency: 1,
        compile: async (sourceText) => {
          successorCalls.push(sourceText);
          return null;
        }
      });

      expect(successorCalls).toEqual(["Beta?", "Gamma?"]);
      expect(binding.entry_count).toBe(3);
      expect(binding.transport_routes).toHaveLength(2);
      const loaded = await readQuerySemanticFactorCache({
        path: outputPath,
        required_source_texts: ["Alpha?", "Beta?", "Gamma?"]
      });
      expect(loaded.captures_by_source_text.size).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates exhausted response-schema failures without stopping unrelated sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-fill-"));
    const outputPath = join(root, "query-cache.json");
    const firstCalls: string[] = [];
    try {
      await expect(fillQuerySemanticFactorSources({
        source_texts: ["Alpha?", "Beta?", "Gamma?"],
        output_path: outputPath,
        model_id: "same-model",
        provider_url: "https://logical-provider.invalid/v1",
        transport: {
          providerUrl: "https://provider.invalid/v1",
          model: "same-model"
        },
        concurrency: 1,
        compile: async (sourceText) => {
          firstCalls.push(sourceText);
          if (sourceText === "Beta?") throw responseSchemaFailure();
          return null;
        }
      })).rejects.toThrow(/1 source-local response-schema failure/u);
      expect(firstCalls).toEqual(["Alpha?", "Beta?", "Gamma?"]);

      const resumedCalls: string[] = [];
      const binding = await fillQuerySemanticFactorSources({
        source_texts: ["Alpha?", "Beta?", "Gamma?"],
        output_path: outputPath,
        model_id: "same-model",
        provider_url: "https://logical-provider.invalid/v1",
        transport: {
          providerUrl: "https://provider.invalid/v1",
          model: "same-model"
        },
        concurrency: 1,
        compile: async (sourceText) => {
          resumedCalls.push(sourceText);
          return null;
        }
      });
      expect(resumedCalls).toEqual(["Beta?"]);
      expect(binding.entry_count).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function responseSchemaFailure(): Error {
  const error = new Error("query semantic factor graph missing or invalid");
  Object.assign(error, {
    benchRetry: {
      retryClassification: "failure_max_retries",
      transportFailures: [{ kind: "response_schema_error" }]
    }
  });
  return error;
}

function resealLegacyV4(cache: unknown): unknown {
  const legacy = structuredClone(cache) as Record<string, unknown>;
  legacy.compiler_operator_id = "open_semantic_factor_query_compiler_v4";
  legacy.system_prompt_sha256 =
    "sha256:63cc29f6ba1465d34f919b3d25bdf9d373cbae797bbe3e2ba124c5888dfa68e4";
  legacy.request_template_sha256 = prefixedSha256(priorRequestTemplate());
  const { cache_content_sha256: _cacheDigest, ...cacheBody } = legacy;
  legacy.cache_content_sha256 = prefixedSha256(stableStringify(cacheBody));
  return legacy;
}

function resealPriorRequestTemplate(cache: unknown): unknown {
  const prior = structuredClone(cache) as Record<string, unknown>;
  prior.request_template_sha256 = prefixedSha256(priorRequestTemplate());
  const { cache_content_sha256: _cacheDigest, ...cacheBody } = prior;
  prior.cache_content_sha256 = prefixedSha256(stableStringify(cacheBody));
  return prior;
}

function priorRequestTemplate(): string {
  return JSON.stringify({
    schema_version: 1,
    source_kind: "query",
    source_text: "{source_text}"
  });
}

function prefixedSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

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
