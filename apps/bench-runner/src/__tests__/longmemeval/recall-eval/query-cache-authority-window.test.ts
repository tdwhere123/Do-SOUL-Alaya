// @ts-nocheck
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  certifyQueryOsfSemanticCompleteness,
  queryOsfSemanticCompletenessReceiptPreimage
} from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import { OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID } from "@do-soul/alaya-soul";
import {
  bindRecallEvalQuerySemanticFactorCache,
  type RecallEvalRunContext
} from "../../../runs/lifecycle/recall-eval/recall-eval-run-context.js";
import { recallOptionsForQuestion } from
  "../../../runs/lifecycle/recall-eval/recall-eval-question-options.js";
import { queryCacheStableJson } from
  "../../../runs/query-factors/cache/document.js";
import {
  createQuerySemanticFactorCache,
  writeQuerySemanticFactorCache
} from "../../../runs/query-factors/query-semantic-factor-cache.js";
import { compileCertifiedQueryCacheValue } from
  "../../../runs/query-factors/query-semantic-factor-cache-certification.js";
import type { RecallEvalSnapshotBundle } from
  "../../../runs/snapshot/recall-eval/recall-eval-loader.js";
import {
  currentSnapshotExtractionAuthority,
  currentSnapshotManifestFor
} from "../snapshot/current-snapshot-fixture.js";
import { redactProvenanceUrl } from "../../../runs/provenance/paired-environment.js";

const COUNT = 100;
const FORMED = "What did I buy?";
const WINDOW = { offset: 97, limit: 3 } as const;
const RAW_PROVIDER_ROUTE = "https://provider.invalid/v1";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recall-eval query cache authority window", () => {
  it("binds the full 100-source sidecar through a 3Q window and fail-closes identity drift", async () => {
    const root = await tempRoot();
    const snapshotDbPath = join(root, "snapshot.db");
    await writeFile(`${snapshotDbPath}.sidecar.json`, `${JSON.stringify(sidecar(COUNT))}\n`);
    const cachePath = join(root, "query-cache.json");
    const { cache, receipt } = await cacheFor(COUNT);
    await writeQuerySemanticFactorCache(cachePath, cache);
    const bundle = liveBundle();
    const options = {
      snapshotDbPath, variant: "longmemeval_s" as const, historyRoot: root,
      querySemanticFactorCachePath: cachePath, ...WINDOW
    };
    const bound = await bindRecallEvalQuerySemanticFactorCache(options, bundle);
    expect(bound.binding.entry_count).toBe(COUNT);
    expect(bound.captures_by_source_text.size).toBe(COUNT);
    const consumed = recallOptionsForQuestion({
      recallOptions: { maxResults: 5, conflictAwareness: true },
      querySemanticFactorCache: bound
    } as RecallEvalRunContext, FORMED, undefined);
    expect(consumed.querySemanticFactorFormationCapture?.status).toBe("formed");
    expect(consumed.querySemanticFactorCompletenessReceipt).toEqual(receipt);

    await expect(bindRecallEvalQuerySemanticFactorCache(options, identityBundle(bundle, {
      request_profile: "mimo-v2.5-nonthinking-v1"
    }))).rejects.toThrow(/request profile/u);
    await expect(bindRecallEvalQuerySemanticFactorCache(options, identityBundle(bundle, {
      extraction_model: "other-model"
    }))).rejects.toThrow(/model/u);
    await expect(bindRecallEvalQuerySemanticFactorCache(options, identityBundle(bundle, {
      provider_url: "https://other-provider.invalid/v1"
    }))).rejects.toThrow(/provider route/u);

    const shortPath = join(root, "short-cache.json");
    await writeQuerySemanticFactorCache(shortPath, (await cacheFor(COUNT - 1)).cache);
    await expect(bindRecallEvalQuerySemanticFactorCache({
      ...options, querySemanticFactorCachePath: shortPath
    }, bundle)).rejects.toThrow(/missing a required query source|source set/u);

    const invalidPath = join(root, "invalid-receipt.json");
    await writeFile(invalidPath, JSON.stringify(resealForeignReceipt(cache)), "utf8");
    await expect(bindRecallEvalQuerySemanticFactorCache({
      ...options, querySemanticFactorCachePath: invalidPath
    }, bundle)).rejects.toThrow(/completeness receipt mismatch|capture integrity/u);

    await writeFile(`${snapshotDbPath}.sidecar.json`, `${JSON.stringify(sidecar(COUNT, "Other"))}\n`);
    await expect(bindRecallEvalQuerySemanticFactorCache(options, bundle))
      .rejects.toThrow(/missing a required query source|source set/u);
  });

  it("binds a once-sealed cache when snapshot provenance already redacted the route", async () => {
    const root = await tempRoot();
    const snapshotDbPath = join(root, "snapshot.db");
    await writeFile(`${snapshotDbPath}.sidecar.json`, `${JSON.stringify(sidecar(COUNT))}\n`);
    const cachePath = join(root, "query-cache.json");
    const { cache } = await cacheFor(COUNT, RAW_PROVIDER_ROUTE);
    await writeQuerySemanticFactorCache(cachePath, cache);
    const redacted = redactProvenanceUrl(RAW_PROVIDER_ROUTE);
    const bundle = identityBundle(liveBundle(), { provider_url: redacted });
    const bound = await bindRecallEvalQuerySemanticFactorCache({
      snapshotDbPath, variant: "longmemeval_s", historyRoot: root,
      querySemanticFactorCachePath: cachePath, ...WINDOW
    }, bundle);
    expect(bound.binding.provider_url_sha256).toBe(redacted);
    expect(bound.binding.entry_count).toBe(COUNT);
  });
});

function liveBundle(): RecallEvalSnapshotBundle {
  const extractionAuthority = currentSnapshotExtractionAuthority();
  return identityBundle({
    snapshotDbPath: "",
    manifest: currentSnapshotManifestFor("q-1"),
    sidecar: sidecar(COUNT),
    extractionAuthority,
    snapshotManifestSha256: null,
    datasetSha256: null,
    measurementForQuestion: null
  }, { provider_url: redactProvenanceUrl(RAW_PROVIDER_ROUTE) });
}

function identityBundle(
  bundle: RecallEvalSnapshotBundle,
  patch: Readonly<{
    request_profile?: "mimo-v2.5-nonthinking-v1";
    extraction_model?: string;
    provider_url?: string;
  }>
): RecallEvalSnapshotBundle {
  return {
    ...bundle,
    extractionAuthority: {
      ...bundle.extractionAuthority!,
      ...(patch.request_profile === undefined ? {} : { request_profile: patch.request_profile }),
      ...(patch.extraction_model === undefined ? {} : { extraction_model: patch.extraction_model })
    },
    manifest: {
      ...bundle.manifest,
      extraction_provenance: {
        ...bundle.manifest.extraction_provenance!,
        ...patch
      }
    }
  };
}

async function cacheFor(count: number, providerUrl?: string) {
  const authority = currentSnapshotExtractionAuthority();
  const provenance = currentSnapshotManifestFor("q-1").extraction_provenance;
  if (provenance === undefined || provenance.schema_version !== 3) {
    throw new Error("fixture requires v3 extraction provenance");
  }
  const formed = count >= COUNT ? await certifiedValue(FORMED) : undefined;
  return {
    receipt: formed?.receipt ?? null,
    cache: createQuerySemanticFactorCache({
      model_id: authority.extraction_model,
      request_profile: authority.request_profile,
      provider_url: providerUrl ?? RAW_PROVIDER_ROUTE,
      entries: Array.from({ length: count }, (_, index) => {
        const source_text = questionText(index);
        if (formed !== undefined && source_text === FORMED) {
          return {
            source_text,
            source_sha256: formed.capture.source_sha256!,
            capture: formed.capture,
            receipt: formed.receipt
          };
        }
        const capture = materializeOpenSemanticFactorFormation({
          source_kind: "query", source_text
        });
        return { source_text, source_sha256: capture.source_sha256!, capture, receipt: null };
      })
    })
  };
}

async function certifiedValue(sourceText: string) {
  return await compileCertifiedQueryCacheValue({
    sourceText,
    compile: async (_source, obligation) => {
      const graph = queryGraphFor(sourceText);
      const receipt = certifyQueryOsfSemanticCompleteness({
        query_text: sourceText, graph, obligation,
        producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
        sha256: (value) => createHash("sha256").update(value, "utf8").digest("hex")
      });
      return receipt === null ? null : {
        schema_version: 1 as const,
        producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
        graph,
        semantic_completeness_receipt: receipt
      };
    }
  });
}

function resealForeignReceipt(cache: unknown): unknown {
  const foreign = structuredClone(cache) as {
    entries: Array<{ receipt: Record<string, unknown> | null }>;
  };
  const receipt = foreign.entries.find((entry) => entry.receipt !== null)?.receipt;
  if (receipt === undefined || receipt === null) {
    throw new Error("fixture requires a formed receipt to reseal");
  }
  receipt.query_digest = prefixedSha256("foreign query");
  const { receipt_digest: _digest, ...body } = receipt;
  receipt.receipt_digest = prefixedSha256(
    queryOsfSemanticCompletenessReceiptPreimage(body as never)
  );
  return resealCache(foreign as unknown as Record<string, unknown>);
}

function resealCache(cache: Record<string, unknown>): unknown {
  const { cache_content_sha256: _digest, ...body } = cache;
  cache.cache_content_sha256 = prefixedSha256(queryCacheStableJson(body));
  return cache;
}

function queryGraphFor(sourceText: string) {
  const predicate = sourceText.slice(11, -1);
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [factor("actor", "I", "i"), factor("predicate", predicate, predicate)],
    variables: [{ variable_id: "answer", surface: "What" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "query", predicate_factor_id: "predicate",
      arguments: [
        argument(0, "factor", "actor", "agent"),
        argument(1, "variable", "answer", "object")
      ]
    }]
  };
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
  return {
    position, reference_kind: referenceKind,
    reference_id: referenceId, binding_identity: bindingIdentity
  };
}

function prefixedSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function questionText(index: number, prefix = "Question"): string {
  return prefix === "Question" && index + 1 === COUNT
    ? FORMED
    : `${prefix} q-${index + 1}?`;
}

function sidecar(count: number, prefix = "Question") {
  return {
    schema_version: 2,
    variant: "longmemeval_s",
    questions: Array.from({ length: count }, (_, index) => ({
      questionId: `q-${index + 1}`,
      question: questionText(index, prefix),
      questionDate: "2026-07-16T00:00:00.000Z",
      answerSessionIds: [],
      sidecar: [],
      seedRounds: [],
      workspaceId: `ws-${index + 1}`,
      runId: `run-${index + 1}`
    }))
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recall-eval-cache-window-"));
  roots.push(root);
  return root;
}
