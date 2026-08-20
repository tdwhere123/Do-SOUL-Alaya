import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  certifyQueryOsfSemanticCompleteness,
  openSemanticFactorFormationCapturePreimage,
  queryOsfSemanticCompletenessReceiptPreimage
} from "@do-soul/alaya-protocol";
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
import { compileCertifiedQueryCacheValue } from
  "../../bench/query-factors/query-semantic-factor-cache-certification.js";

const SOURCES = ["What did I buy?", "What did I choose?", "What did I use?"] as const;
describe("query semantic factor cache", () => {
  it("replays a source-bound formation capture without provider configuration", async () => {
    const sourceText = SOURCES[0];
    const { capture, receipt } = await certifiedValue(sourceText);
    expect(capture.status).toBe("formed");
    const cache = createQuerySemanticFactorCache({
      model_id: "test-model",
      provider_url: "https://provider.invalid/v1",
      entries: [{
        source_text: sourceText,
        source_sha256: capture.source_sha256!,
        capture,
        receipt
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
        .toBe("open_semantic_factor_query_compiler_v8");
      expect(loaded.binding.request_template_sha256)
        .toBe(prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE));
      expect(loaded.captures_by_source_text.get(sourceText)).toEqual(capture);
      expect(loaded.receipts_by_source_text.get(sourceText)).toEqual(receipt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an honestly resealed prior v7 compiler cache", async () => {
    const sourceText = SOURCES[0];
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
        capture,
        receipt: null
      }]
    });
    const legacy = resealLegacyV7(cache);
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
    const sourceText = SOURCES[0];
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
        capture,
        receipt: null
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

  it("rejects old, missing, and foreign completeness authority", async () => {
    const sourceText = SOURCES[0];
    const value = await certifiedValue(sourceText);
    const cache = createQuerySemanticFactorCache({
      model_id: "test-model", provider_url: "https://provider.invalid/v1",
      entries: [{ source_text: sourceText, source_sha256: value.capture.source_sha256!,
        capture: value.capture, receipt: value.receipt }]
    });
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-cache-"));
    try {
      for (const [name, mutated] of Object.entries({
        old: resealOldV5(cache),
        missing: resealMissingReceipt(cache),
        foreign: resealForeignReceipt(cache)
      })) {
        const path = join(root, `${name}.json`);
        await writeFile(path, JSON.stringify(mutated), "utf8");
        await expect(readQuerySemanticFactorCache({
          path, required_source_texts: [sourceText]
        })).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a cache that does not close the requested query source set", async () => {
    const capture = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: SOURCES[0]
    });
    const cache = createQuerySemanticFactorCache({
      model_id: "test-model",
      provider_url: "https://provider.invalid/v1",
      entries: [{
        source_text: SOURCES[0],
        source_sha256: capture.source_sha256!,
        capture,
        receipt: null
      }]
    });
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-cache-"));
    const outputPath = join(root, "query-cache.json");
    try {
      await writeQuerySemanticFactorCache(outputPath, cache);
      await expect(readQuerySemanticFactorCache({
        path: outputPath,
        required_source_texts: ["Who did I call?"]
      })).rejects.toThrow("missing a required query source");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes successful sources through a same-model transport switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-fill-"));
    const outputPath = join(root, "query-cache.json");
    const firstCompile = async (sourceText: string) => {
      if (sourceText === SOURCES[1]) throw new Error("primary transport unavailable");
      return null;
    };
    const firstCalls: string[] = [];
    try {
      await expect(fillQuerySemanticFactorSources({
        source_texts: SOURCES,
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
      expect(firstCalls).toEqual(SOURCES.slice(0, 2));

      const driftedCalls: string[] = [];
      await expect(fillQuerySemanticFactorSources({
        source_texts: SOURCES,
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
        source_texts: SOURCES,
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

      expect(successorCalls).toEqual(SOURCES.slice(1));
      expect(binding.entry_count).toBe(3);
      expect(binding.transport_routes).toHaveLength(2);
      const loaded = await readQuerySemanticFactorCache({
        path: outputPath,
        required_source_texts: SOURCES
      });
      expect(loaded.captures_by_source_text.size).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupted certified shards before partial resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "alaya-query-factor-resume-"));
    try {
      for (const mutation of [removeReceipt, resealForeignPartialReceipt,
        resealForeignPartialCapture]) {
        const outputPath = join(root, `${mutation.name}.json`);
        await seedPartialCertifiedFill(outputPath);
        await mutateOnlyShard(outputPath, mutation);
        const calls: string[] = [];
        await expect(fillForResume(outputPath, calls)).rejects.toThrow();
        expect(calls).toEqual([]);
      }
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
        source_texts: SOURCES,
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
          if (sourceText === SOURCES[1]) throw responseSchemaFailure();
          return null;
        }
      })).rejects.toThrow(/1 source-local response-schema failure/u);
      expect(firstCalls).toEqual(SOURCES);

      const resumedCalls: string[] = [];
      const binding = await fillQuerySemanticFactorSources({
        source_texts: SOURCES,
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
      expect(resumedCalls).toEqual([SOURCES[1]]);
      expect(binding.entry_count).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function certifiedValue(sourceText: string) {
  return await compileCertifiedQueryCacheValue({
    sourceText,
    compile: async (_source, obligation) => {
      const graph = queryGraphFor(sourceText);
      const receipt = certifyQueryOsfSemanticCompleteness({
        query_text: sourceText,
        graph,
        obligation,
        producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
        sha256: (value) => createHash("sha256").update(value, "utf8").digest("hex")
      });
      return receipt === null ? null : {
        schema_version: 1,
        producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
        graph,
        semantic_completeness_receipt: receipt
      };
    }
  });
}

async function seedPartialCertifiedFill(outputPath: string): Promise<void> {
  await expect(fillQuerySemanticFactorSources({
    ...fillInput(outputPath),
    compile: async (sourceText, obligation) => {
      if (sourceText === SOURCES[1]) throw new Error("stop after first shard");
      return await certifiedGraph(sourceText, obligation);
    }
  })).rejects.toThrow("stop after first shard");
}

async function fillForResume(outputPath: string, calls: string[]) {
  return await fillQuerySemanticFactorSources({
    ...fillInput(outputPath),
    compile: async (sourceText) => { calls.push(sourceText); return null; }
  });
}
function fillInput(outputPath: string) {
  return { source_texts: SOURCES.slice(0, 2), output_path: outputPath,
    model_id: "same-model", provider_url: "https://logical-provider.invalid/v1",
    transport: { providerUrl: "https://provider.invalid/v1", model: "same-model" },
    concurrency: 1 } as const;
}
async function certifiedGraph(sourceText: string, obligation: Parameters<
  Parameters<typeof fillQuerySemanticFactorSources>[0]["compile"]
>[1]) {
  const graph = queryGraphFor(sourceText);
  const receipt = certifyQueryOsfSemanticCompleteness({ query_text: sourceText, graph,
    obligation, producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    sha256: (value) => createHash("sha256").update(value, "utf8").digest("hex") });
  return receipt === null ? null : { schema_version: 1 as const,
    producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID, graph,
    semantic_completeness_receipt: receipt };
}
async function mutateOnlyShard(
  outputPath: string,
  mutate: (shard: Record<string, any>) => void
): Promise<void> {
  const shardRoot = join(`${outputPath}.partial`, "shards");
  const [name] = await readdir(shardRoot);
  const path = join(shardRoot, name!);
  const shard = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  mutate(shard);
  await writeFile(path, JSON.stringify(shard), "utf8");
}

function removeReceipt(shard: Record<string, any>): void { delete shard.receipt; }

function resealForeignPartialReceipt(shard: Record<string, any>): void {
  shard.receipt.query_digest = prefixedSha256("foreign query");
  const { receipt_digest: _digest, ...body } = shard.receipt;
  shard.receipt.receipt_digest = prefixedSha256(
    queryOsfSemanticCompletenessReceiptPreimage(body)
  );
}

function resealForeignPartialCapture(shard: Record<string, any>): void {
  shard.capture.producer_operator_id = "foreign_query_v6";
  const { capture_digest: _digest, ...body } = shard.capture;
  shard.capture.capture_digest = prefixedSha256(
    openSemanticFactorFormationCapturePreimage(body)
  );
}

function queryGraphFor(sourceText: string) {
  const predicate = sourceText.slice(11, -1);
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [factor("actor", "I", "i"), factor("predicate", predicate, predicate)],
    variables: [{ variable_id: "answer", surface: "What" }],
    result_variable_ids: ["answer"],
    propositions: [{ proposition_id: "query", predicate_factor_id: "predicate",
      arguments: [argument(0, "factor", "actor", "agent"),
        argument(1, "variable", "answer", "object")] }]
  };
}

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

function resealLegacyV7(cache: unknown): unknown {
  const legacy = structuredClone(cache) as Record<string, unknown>;
  legacy.compiler_operator_id = "open_semantic_factor_query_compiler_v7";
  legacy.system_prompt_sha256 =
    "sha256:da13495a266e25890113ae8a1f5560c88fd26026d1432217592728482cd88c70";
  legacy.request_template_sha256 = "sha256:92dea9f910b9d06abdc54af40444602bca23041b43eda4aa9a93c92a557e0aa2";
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

function resealOldV5(cache: unknown): unknown {
  const old = structuredClone(cache) as Record<string, unknown>;
  old.schema_version = 2;
  old.compiler_operator_id = "open_semantic_factor_query_compiler_v5";
  return resealCache(old);
}

function resealMissingReceipt(cache: unknown): unknown {
  const missing = structuredClone(cache) as { entries: Record<string, unknown>[] };
  delete missing.entries[0]!.receipt;
  return resealCache(missing as unknown as Record<string, unknown>);
}

function resealForeignReceipt(cache: unknown): unknown {
  const foreign = structuredClone(cache) as {
    entries: Array<{ receipt: Record<string, unknown> }>;
  };
  const receipt = foreign.entries[0]!.receipt;
  receipt.query_digest = prefixedSha256("foreign query");
  const { receipt_digest: _digest, ...body } = receipt;
  receipt.receipt_digest = prefixedSha256(
    queryOsfSemanticCompletenessReceiptPreimage(body as never)
  );
  return resealCache(foreign as unknown as Record<string, unknown>);
}

function resealCache(cache: Record<string, unknown>): unknown {
  const { cache_content_sha256: _digest, ...body } = cache;
  cache.cache_content_sha256 = prefixedSha256(stableStringify(body));
  return cache;
}

function priorRequestTemplate(): string {
  return JSON.stringify({ schema_version: 1, source_kind: "query",
    source_text: "{source_text}" });
}

function prefixedSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  referenceKind: "factor" | "variable",
  referenceId: string,
  bindingIdentity: string
) {
  return { position, reference_kind: referenceKind,
    reference_id: referenceId, binding_identity: bindingIdentity };
}
