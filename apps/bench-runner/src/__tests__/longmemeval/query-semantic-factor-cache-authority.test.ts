import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeOpenSemanticFactorFormation,
  stableStringify
} from "@do-soul/alaya-core";
import {
  resolveDiagnosticLoopIdentity,
  resolveDiagnosticQueryFactorCacheIdentity
} from
  "../../bench/diagnostic-loop/authority/identity.js";
import {
  bindCurrentQuerySemanticFactorCache,
  createQuerySemanticFactorCache,
  fillQuerySemanticFactorSources,
  querySemanticFactorCacheSourceSetSha256,
  readQuerySemanticFactorCache
} from "../../bench/query-factors/query-semantic-factor-cache.js";
import {
  loopRequest,
  writeDiagnosticSnapshotFixture,
  writeQueryFactorCacheFixture
} from "./diagnostic-loop/fixture.js";
import {
  QUERY_SEMANTIC_FACTOR_CACHE_DIAGNOSTIC_SCHEMA_VERSION,
  QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION,
  QuerySemanticFactorCacheProvenanceIdentitySchema,
  assertQuerySemanticFactorCacheMatchesRequest,
  inspectQuerySemanticFactorCacheIdentity
} from "../../bench/query-factors/query-semantic-factor-cache-identity.js";
import { redactProvenanceUrl } from "../../bench/provenance/paired-environment.js";

const SOURCE = "What did I buy?";
const PROFILE = "provider-default-v1" as const;
const MIMO_PROFILE = "mimo-v2.5-nonthinking-v1" as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("query semantic factor cache authority", () => {
  it("classifies schema 3, v7 compiler, and missing profile as diagnostic-only", async () => {
    const cache = currentCache();
    const cases = [
      ["schema_version", reseal({ ...clone(cache), schema_version: 3 })],
      ["compiler_operator_id", reseal({
        ...clone(cache),
        compiler_operator_id: "open_semantic_factor_query_compiler_v7"
      })],
      ["request_profile", reseal(omit(clone(cache), "request_profile"))]
    ] as const;
    for (const [reason, raw] of cases) {
      const inspection = inspectQuerySemanticFactorCacheIdentity(raw);
      expect(inspection.kind).toBe("diagnostic_only");
      if (inspection.kind === "diagnostic_only") expect(inspection.reason).toBe(reason);
      await expect(readMutated(raw)).rejects.toThrow(/cannot bind as current authority/u);
    }
  });

  it("parses schema 3 identity as archive provenance and refuses it as current authority", () => {
    const current = toBindingProjection(currentCache());
    const archived = {
      ...omit(current, "request_profile"),
      schema_version: QUERY_SEMANTIC_FACTOR_CACHE_DIAGNOSTIC_SCHEMA_VERSION
    };
    expect(QuerySemanticFactorCacheProvenanceIdentitySchema.parse(archived)).toEqual(archived);
    expect(inspectQuerySemanticFactorCacheIdentity(archived).kind).toBe("diagnostic_only");
    expect(() => bindCurrentQuerySemanticFactorCache(currentCache(), [SOURCE])).not.toThrow();
    expect(() => QuerySemanticFactorCacheProvenanceIdentitySchema.parse(
      omit(current, "request_profile")
    )).toThrow();
    for (const key of ["transport_routes", "source_set_sha256", "cache_content_sha256"] as const) {
      expect(() => QuerySemanticFactorCacheProvenanceIdentitySchema.parse(omit(current, key)))
        .toThrow();
    }
  });

  it("loads schema 4 current identity and fail-closes profile, model, and provider drift", async () => {
    const cache = currentCache();
    const loaded = await readMutated(cache);
    expect(loaded.binding.schema_version).toBe(QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION);
    expect(loaded.binding.request_profile).toBe(PROFILE);
    assertQuerySemanticFactorCacheMatchesRequest(loaded.binding, {
      requestProfile: PROFILE, model: "test-model", providerRoute: "https://provider.invalid/v1"
    });
    expect(() => assertQuerySemanticFactorCacheMatchesRequest(loaded.binding, {
      requestProfile: MIMO_PROFILE, model: "test-model", providerRoute: "https://provider.invalid/v1"
    })).toThrow(/request profile/u);
    expect(() => assertQuerySemanticFactorCacheMatchesRequest(loaded.binding, {
      requestProfile: PROFILE, model: "other-model", providerRoute: "https://provider.invalid/v1"
    })).toThrow(/model/u);
    expect(() => assertQuerySemanticFactorCacheMatchesRequest(loaded.binding, {
      requestProfile: PROFILE, model: "test-model", providerRoute: "other-route"
    })).toThrow(/provider route/u);
  });

  it("compares an already-redacted snapshot route as a digest, not a second hash", async () => {
    const rawRoute = "https://provider.invalid/v1";
    const loaded = await readMutated(currentCache());
    const redacted = redactProvenanceUrl(rawRoute);
    expect(redacted).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(redacted).not.toBe(rawRoute);
    assertQuerySemanticFactorCacheMatchesRequest(loaded.binding, {
      requestProfile: PROFILE, model: "test-model", providerRoute: redacted
    });
    expect(() => assertQuerySemanticFactorCacheMatchesRequest(loaded.binding, {
      requestProfile: PROFILE, model: "test-model", providerRoute: "sha256:not-a-digest"
    })).toThrow(/malformed/u);
    expect(() => assertQuerySemanticFactorCacheMatchesRequest(loaded.binding, {
      requestProfile: PROFILE,
      model: "test-model",
      providerRoute: redactProvenanceUrl("https://other-provider.invalid/v1")
    })).toThrow(/provider route/u);
  });

  it("fail-closes a current header whose content digest drifted", () => {
    const raw = clone(currentCache());
    raw.cache_content_sha256 = prefixedSha256("drifted-body");
    expect(inspectQuerySemanticFactorCacheIdentity(raw).kind).toBe("current");
    expect(() => bindCurrentQuerySemanticFactorCache(raw, [SOURCE]))
      .toThrow(/content digest mismatch/u);
  });

  it("keeps an obsolete request profile diagnostic-only", async () => {
    const raw = reseal({ ...clone(currentCache()), request_profile: "deepseek-v4-nonthinking-v1" });
    const inspection = inspectQuerySemanticFactorCacheIdentity(raw);
    expect(inspection.kind).toBe("diagnostic_only");
    await expect(readMutated(raw)).rejects.toThrow(/cannot bind as current authority/u);
    expect(() => createQuerySemanticFactorCache({
      model_id: "test-model",
      request_profile: "deepseek-v4-nonthinking-v1",
      provider_url: "https://provider.invalid/v1",
      entries: currentEntries()
    })).toThrow(/request profile is not current authority/u);
  });

  it("rejects a current-schema cache whose request template is not this runtime", async () => {
    const raw = reseal({
      ...clone(currentCache()),
      request_template_sha256: prefixedSha256(priorRequestTemplate())
    });
    expect(inspectQuerySemanticFactorCacheIdentity(raw).kind).toBe("rejected");
    await expect(readMutated(raw)).rejects.toThrow(/cannot bind as current authority/u);
  });

  it("fail-closes snapshot source-set coverage and exact-digest drift", async () => {
    const extra = createQuerySemanticFactorCache({
      model_id: "test-model",
      request_profile: PROFILE,
      provider_url: "https://provider.invalid/v1",
      entries: [
        ...currentEntries(),
        extraEntry("What did I choose?")
      ]
    });
    expect(() => bindCurrentQuerySemanticFactorCache(extra, [SOURCE]))
      .toThrow(/source set does not match this request/u);
    expect(extra.source_set_sha256).not.toBe(
      querySemanticFactorCacheSourceSetSha256([SOURCE])
    );

    const root = await tempRoot();
    const snapshot = await writeDiagnosticSnapshotFixture(root, "source-set");
    const cachePath = join(root, "query-cache.json");
    await writeQueryFactorCacheFixture(cachePath, "Question A?");
    await expect(resolveDiagnosticLoopIdentity(loopRequest({
      snapshotPath: snapshot,
      treatmentFactorCachePath: cachePath
    }))).rejects.toThrow(/missing a required query source|source set does not match/u);

    await rm(cachePath);
    await writeQueryFactorCacheFixture(cachePath, "Question q-1?");
    const identity = await resolveDiagnosticLoopIdentity(loopRequest({
      snapshotPath: snapshot,
      treatmentFactorCachePath: cachePath
    }));
    expect(identity.query_factor_cache?.source_set_sha256).toBe(
      querySemanticFactorCacheSourceSetSha256(["Question q-1?"])
    );
  });

  it("binds a snapshot-out query cache to the pinned dataset window", async () => {
    const root = await tempRoot();
    const cachePath = join(root, "query-cache.json");
    await writeQueryFactorCacheFixture(cachePath, "Question q-1?");
    const request = loopRequest({
      snapshotOutPath: join(root, "snapshot.db"),
      treatmentFactorCachePath: cachePath,
      limit: 1,
      offset: 0
    });

    const identity = await resolveDiagnosticQueryFactorCacheIdentity(
      request,
      async () => ({
        datasetRevision: request.datasetRevision,
        questions: [{ question: "Question q-1?" }]
      })
    );

    expect(identity.source_set_sha256).toBe(
      querySemanticFactorCacheSourceSetSha256(["Question q-1?"])
    );
    await expect(resolveDiagnosticQueryFactorCacheIdentity(
      request,
      async () => ({
        datasetRevision: "other-revision",
        questions: [{ question: "Question q-1?" }]
      })
    )).rejects.toThrow(/dataset revision/u);
    await expect(resolveDiagnosticQueryFactorCacheIdentity(
      request,
      async () => ({
        datasetRevision: request.datasetRevision,
        questions: [
          { question: "Question q-1?" },
          { question: "Question q-2?" }
        ]
      })
    )).rejects.toThrow(/dataset window/u);
  });

  it("does not resume a partial fill across request profiles", async () => {
    const root = await tempRoot();
    const outputPath = join(root, "query-cache.json");
    await expect(fillQuerySemanticFactorSources({
      source_texts: [SOURCE, "What did I choose?"],
      output_path: outputPath,
      model_id: "same-model",
      request_profile: PROFILE,
      provider_url: "https://logical-provider.invalid/v1",
      transport: { providerUrl: "https://primary.invalid/v1", model: "same-model" },
      concurrency: 1,
      compile: async (sourceText) => {
        if (sourceText !== SOURCE) throw new Error("stop after first source");
        return null;
      }
    })).rejects.toThrow(/stop after first source/u);

    const driftedCalls: string[] = [];
    await expect(fillQuerySemanticFactorSources({
      source_texts: [SOURCE, "What did I choose?"],
      output_path: outputPath,
      model_id: "same-model",
      request_profile: MIMO_PROFILE,
      provider_url: "https://logical-provider.invalid/v1",
      transport: { providerUrl: "https://primary.invalid/v1", model: "same-model" },
      concurrency: 1,
      compile: async (sourceText) => {
        driftedCalls.push(sourceText);
        return null;
      }
    })).rejects.toThrow(/partial cache identity mismatch/u);
    expect(driftedCalls).toEqual([]);
  });
});

function currentCache() {
  return createQuerySemanticFactorCache({
    model_id: "test-model",
    request_profile: PROFILE,
    provider_url: "https://provider.invalid/v1",
    entries: currentEntries()
  });
}

function currentEntries() {
  return [extraEntry(SOURCE)];
}

function extraEntry(sourceText: string) {
  const capture = materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: sourceText
  });
  return {
    source_text: sourceText,
    source_sha256: capture.source_sha256!,
    capture,
    receipt: null
  };
}

function toBindingProjection(cache: ReturnType<typeof currentCache>) {
  const { entries, ...fields } = cache;
  return { ...fields, entry_count: entries.length };
}

async function readMutated(raw: unknown) {
  const root = await tempRoot();
  const path = join(root, "query-cache.json");
  await writeFile(path, JSON.stringify(raw), "utf8");
  return await readQuerySemanticFactorCache({
    path,
    required_source_texts: [SOURCE],
    requestProfile: PROFILE,
    model: "test-model",
    providerRoute: "https://provider.invalid/v1"
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "query-cache-authority-"));
  roots.push(root);
  return root;
}

function clone(cache: unknown): Record<string, unknown> {
  return structuredClone(cache) as Record<string, unknown>;
}

function omit(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function reseal(cache: Record<string, unknown>): unknown {
  const { cache_content_sha256: _digest, ...body } = cache;
  cache.cache_content_sha256 = prefixedSha256(stableStringify(body));
  return cache;
}

function priorRequestTemplate(): string {
  return JSON.stringify({
    schema_version: 1, source_kind: "query", source_text: "{source_text}"
  });
}

function prefixedSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
