import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { certifyQueryOsfSemanticCompleteness } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import { OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID } from "@do-soul/alaya-soul";
import { resolveDiagnosticLoopIdentity } from
  "../../../bench/diagnostic-loop/authority/identity.js";
import { runPreflightPhase } from
  "../../../bench/diagnostic-loop/production-phases.js";
import { persistRunRecord } from "../../../bench/diagnostic-loop/run-state.js";
import { bindRecallEvalQuerySemanticFactorCache } from
  "../../../bench/lifecycle/recall-eval/recall-eval-run-context.js";
import { proveProviderZeroCallReplay } from
  "../../../bench/provider/replay-proof.js";
import {
  bindQuerySemanticFactorCacheFileToRequest,
  createQuerySemanticFactorCache,
  writeQuerySemanticFactorCache
} from "../../../bench/query-factors/query-semantic-factor-cache.js";
import { compileCertifiedQueryCacheValue } from
  "../../../bench/query-factors/query-semantic-factor-cache-certification.js";
import {
  digest,
  loopIdentity,
  loopRequest,
  writeDiagnosticSnapshotFixture,
  writeQueryFactorCacheFixture
} from "../diagnostic-loop/fixture.js";
import { MIMO, writeCompleteMimoCache } from
  "../provider/preflight/complete-mimo-cache.js";
import {
  currentSnapshotExtractionAuthority,
  currentSnapshotManifestFor
} from "../snapshot/current-snapshot-fixture.js";

const SOURCE = "What did I buy?";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("query cache file digest phase rebind", () => {
  it("fail-closes preflight and replay when a later legal current cache replaces the recorded digest", async () => {
    const root = await tempRoot();
    const workRoot = join(root, "work");
    const snapshot = await writeDiagnosticSnapshotFixture(root, "digest-phase", SOURCE);
    const cachePath = join(root, "query-cache.json");
    await writeQueryFactorCacheFixture(cachePath, SOURCE);
    const extractionCacheRoot = join(root, "extraction-cache");
    const key = digest("key-1");
    const extraction = writeCompleteMimoCache(extractionCacheRoot, key);
    const request = loopRequest({
      snapshotPath: snapshot,
      treatmentFactorCachePath: cachePath,
      extractionCacheRoot,
      requestedKeys: [key],
      promptDigest: extraction.systemPromptSha256,
      model: MIMO.id,
      requestProfile: MIMO.requestProfile
    });
    const identity = await resolveDiagnosticLoopIdentity(request);
    persistRunRecord({ workRoot, identity, mode: "run", argv: [] });
    const recorded = identity.query_factor_cache?.file_sha256;
    expect(recorded).toMatch(/^[a-f0-9]{64}$/u);

    await rm(cachePath);
    await writeFormedCache(cachePath, SOURCE, "loop");
    await expect(runPreflightPhase({
      workRoot, request, mode: "run", checkpoints: new Map()
    }, { ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0" }))
      .rejects.toThrow(/digest drifted after bind/u);
    await expect(proveProviderZeroCallReplay({
      request, expectedFileSha256: recorded
    })).rejects.toThrow(/digest drifted after bind/u);
  });

  it("fail-closes recall-eval rebind after mid-phase replace with another legal current cache", async () => {
    const root = await tempRoot();
    const snapshotDbPath = join(root, "snapshot.db");
    await writeFile(`${snapshotDbPath}.sidecar.json`, `${JSON.stringify({
      schema_version: 2, variant: "longmemeval_s",
      questions: [{
        questionId: "q-1", question: SOURCE,
        questionDate: "2026-07-16T00:00:00.000Z",
        answerSessionIds: [], sidecar: [], seedRounds: [],
        workspaceId: "ws-1", runId: "run-1"
      }]
    })}\n`);
    const cachePath = join(root, "query-cache.json");
    await writeFormedCache(cachePath, SOURCE, "snapshot");
    const authority = currentSnapshotExtractionAuthority();
    const provenance = currentSnapshotManifestFor("q-1").extraction_provenance!;
    const first = await bindQuerySemanticFactorCacheFileToRequest(cachePath, {
      requestProfile: authority.request_profile,
      model: authority.extraction_model,
      providerRoute: provenance.provider_url,
      snapshotPath: snapshotDbPath
    });
    const bundle = {
      snapshotDbPath,
      manifest: currentSnapshotManifestFor("q-1"),
      sidecar: { schema_version: 2 as const, variant: "longmemeval_s" as const, questions: [] },
      extractionAuthority: authority,
      snapshotManifestSha256: null,
      datasetSha256: null,
      measurementForQuestion: null
    };
    const options = {
      snapshotDbPath, variant: "longmemeval_s" as const, historyRoot: root,
      querySemanticFactorCachePath: cachePath
    };
    expect((await bindRecallEvalQuerySemanticFactorCache(options, bundle)).binding.entry_count)
      .toBe(1);

    await rm(cachePath);
    await writeUnavailableSnapshotCache(cachePath, SOURCE);
    await expect(bindRecallEvalQuerySemanticFactorCache({
      ...options, querySemanticFactorCacheFileSha256: first.file_sha256
    }, bundle)).rejects.toThrow(/digest drifted after bind/u);
  });
});

async function writeFormedCache(
  path: string,
  sourceText: string,
  identityKind: "loop" | "snapshot"
): Promise<void> {
  const value = await certifiedValue(sourceText);
  const identity = identityKind === "loop" ? loopSeal() : snapshotSeal();
  await writeQuerySemanticFactorCache(path, createQuerySemanticFactorCache({
    ...identity,
    entries: [{
      source_text: sourceText,
      source_sha256: value.capture.source_sha256!,
      capture: value.capture,
      receipt: value.receipt
    }]
  }));
}

async function writeUnavailableSnapshotCache(path: string, sourceText: string): Promise<void> {
  const capture = materializeOpenSemanticFactorFormation({
    source_kind: "query", source_text: sourceText
  });
  await writeQuerySemanticFactorCache(path, createQuerySemanticFactorCache({
    ...snapshotSeal(),
    entries: [{
      source_text: sourceText, source_sha256: capture.source_sha256!, capture, receipt: null
    }]
  }));
}

function loopSeal() {
  const identity = loopIdentity();
  return {
    model_id: identity.model,
    request_profile: identity.requestProfile as "mimo-v2.5-nonthinking-v1",
    provider_url: identity.providerRoute
  };
}

function snapshotSeal() {
  const authority = currentSnapshotExtractionAuthority();
  const provenance = currentSnapshotManifestFor("q-1").extraction_provenance;
  if (provenance === undefined || provenance.schema_version !== 3) {
    throw new Error("fixture requires v3 extraction provenance");
  }
  return {
    model_id: authority.extraction_model,
    request_profile: authority.request_profile,
    provider_url: provenance.provider_url
  };
}

async function certifiedValue(sourceText: string) {
  return await compileCertifiedQueryCacheValue({
    sourceText,
    compile: async (_source, obligation) => {
      const predicate = sourceText.slice(11, -1);
      const graph = {
        schema_version: 2 as const,
        source_kind: "query" as const,
        factors: [
          { factor_id: "actor", surface: "I", semantic_identity: "i" },
          { factor_id: "predicate", surface: predicate, semantic_identity: predicate }
        ],
        variables: [{ variable_id: "answer", surface: "What" }],
        result_variable_ids: ["answer"],
        propositions: [{
          proposition_id: "query", predicate_factor_id: "predicate",
          arguments: [
            { position: 0, reference_kind: "factor" as const,
              reference_id: "actor", binding_identity: "agent" },
            { position: 1, reference_kind: "variable" as const,
              reference_id: "answer", binding_identity: "object" }
          ]
        }]
      };
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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "query-cache-digest-phase-"));
  roots.push(root);
  return root;
}
