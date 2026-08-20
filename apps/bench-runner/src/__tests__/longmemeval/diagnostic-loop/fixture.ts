import { sha256Utf8 } from "../../../bench/diagnostic-loop/identity.js";
import { sharedSubstrateIdentities } from "../../../bench/diagnostic-loop/run.js";
import type {
  DiagnosticLoopAdapters,
  DiagnosticLoopIdentity,
  DiagnosticLoopPhaseResult,
  DiagnosticLoopRequest
} from "../../../bench/diagnostic-loop/types.js";
import type { DiagnosticLoopPhase } from "../../../bench/diagnostic-loop/phases.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initDatabase } from "@do-soul/alaya-storage";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import {
  createQuerySemanticFactorCache,
  writeQuerySemanticFactorCache
} from "../../../bench/query-factors/query-semantic-factor-cache.js";
import { renderSnapshotExtractionAuthority } from
  "../../../bench/snapshot/extraction-authority.js";
import { writeCachedExtraction } from
  "../../../bench/compile-seed/cache/cache-shard.js";
import {
  writeExtractionCacheManifest,
  type ExtractionCacheManifestV3
} from "../../../bench/extraction/cache/extraction-cache-manifest.js";
import {
  buildExtractionContentClosureIndex,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from "../../../bench/extraction/content-closure.js";
import {
  diagnosticAuthorityDigest,
  resolveExtractionCacheIdentity,
  resolveSnapshotIdentity
} from "../../../bench/diagnostic-loop/authority/identity.js";
import {
  currentSnapshotExtractionAuthority,
  currentSnapshotManifestFor,
  currentSnapshotSidecarFor
} from "../snapshot/current-snapshot-fixture.js";
import { sha256File } from "../../../bench/snapshot/integrity.js";
import { gzipSync } from "node:zlib";
import { missLedgerContentIdentity } from
  "../../../bench/diagnostic-loop/miss-ledger-authority.js";

export function digest(seed: string): string {
  return sha256Utf8(seed);
}

export function loopIdentity(
  overrides: Partial<DiagnosticLoopIdentity> = {}
): DiagnosticLoopIdentity {
  return {
    datasetRevision: digest("dataset"),
    requestedKeys: [digest("key-1")],
    providerRoute: "mimo",
    model: "mimo-v2.5",
    requestProfile: "mimo-v2.5-nonthinking-v1",
    promptDigest: digest("prompt"),
    schemaDigest: digest("schema"),
    operatorDigest: digest("operator"),
    cacheMode: "cache_only",
    variant: "longmemeval_s",
    worker: false,
    ...overrides
  };
}

export function loopRequest(
  overrides: Partial<DiagnosticLoopRequest> = {}
): DiagnosticLoopRequest {
  return { ...loopIdentity(), ...overrides };
}

export function trackingAdapters(network: { calls: number } = { calls: 0 }): {
  readonly calls: DiagnosticLoopPhase[];
  readonly adapters: DiagnosticLoopAdapters;
} {
  const calls: DiagnosticLoopPhase[] = [];
  const handler = (phase: Exclude<DiagnosticLoopPhase, "report">) =>
    async (context: Parameters<DiagnosticLoopAdapters["preflight"]>[0]):
      Promise<DiagnosticLoopPhaseResult> => {
      calls.push(phase);
      const artifactPaths = trackingArtifactPaths(phase, context);
      return {
        contentIdentity: phase === "miss_ledger"
          ? missLedgerContentIdentity(
              context.checkpoints.get("control_recall"),
              context.checkpoints.get("treatment_recall")
            )
          : digest(`${phase}:${context.request.datasetRevision}`),
        physicalCalls: 0,
        artifactPaths,
        details: phase === "control_recall" || phase === "treatment_recall"
          ? await trackingRecallDetails(context, artifactPaths)
          : phase === "miss_ledger"
            ? await trackingMissLedgerDetails(context, artifactPaths)
            : {},
        noProviderCallReceipt: injectedNoProviderReceipt()
      };
    };
  return {
    calls,
    adapters: {
      preflight: handler("preflight"),
      authority_cache: handler("authority_cache"),
      extraction: async (context) => {
        if (network.calls > 0) network.calls += 1;
        calls.push("extraction");
        return trackingExtractionResult(context);
      },
      snapshot: async (context) => {
        calls.push("snapshot");
        return await trackingSnapshotResult(context);
      },
      control_recall: handler("control_recall"),
      treatment_recall: handler("treatment_recall"),
      miss_ledger: handler("miss_ledger")
    }
  };
}

async function trackingMissLedgerDetails(
  context: Parameters<DiagnosticLoopAdapters["preflight"]>[0],
  paths: Readonly<Record<string, string>>
) {
  const gate = {
    schema_version: 1,
    kind: "cached_f3_exposed_denominator_gate",
    declared_minimum_rate: 1,
    evaluated_count: 0,
    exposed_count: 0,
    actual_rate: 0,
    passed: false
  };
  await writeFile(paths.missLedger!, `${JSON.stringify({
    schema_version: 5,
    kind: "diagnostic_100q_f0f2_vs_cached_f3",
    physical_calls: 0,
    five_hundred_q_closed: true,
    control_misses: { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 },
    treatment_misses: { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 },
    membership_improved: [],
    still_missing: [],
    not_exercised: [],
    inconclusive: [],
    treatment_exposure_receipts: [],
    causal_comparison_status: "inconclusive",
    exposed_denominator_gate: gate
  })}\n`, "utf8");
  return {
    ...sharedSubstrateIdentities(context),
    artifact_sha256: await sha256File(paths.missLedger!),
    exposed_denominator_gate: gate
  };
}

async function trackingRecallDetails(
  context: Parameters<DiagnosticLoopAdapters["preflight"]>[0],
  paths: Readonly<Record<string, string>>
) {
  const keys = ["kpi", "report", "diagnostics"] as const;
  await Promise.all(keys.map(async (key) => await writeFile(
    paths[key]!,
    key === "diagnostics" ? gzipSync(JSON.stringify({
      schema_version: 2,
      kind: "recall_eval_diagnostics",
      questions: []
    })) : key,
    key === "diagnostics" ? undefined : "utf8"
  )));
  const hashes = await Promise.all(keys.map(async (key) => [
    key, await sha256File(paths[key]!)
  ] as const));
  return {
    ...sharedSubstrateIdentities(context),
    evaluation_slice: {
      offset: context.request.offset ?? 0,
      limit: context.request.limit ?? null,
      evaluated_count: context.request.limit ?? 1,
      question_id_digest: digest("tracking-question-window")
    },
    artifact_sha256: Object.fromEntries(hashes)
  };
}

function trackingArtifactPaths(
  phase: Exclude<DiagnosticLoopPhase, "report">,
  context: Parameters<DiagnosticLoopAdapters["preflight"]>[0]
): Readonly<Record<string, string>> {
  if (phase === "preflight") return {};
  if (phase === "authority_cache") {
    return { cacheRoot: context.request.extractionCacheRoot ?? context.workRoot };
  }
  if (phase === "control_recall" || phase === "treatment_recall") {
    const root = join(context.workRoot, phase);
    return {
      snapshot: context.checkpoints.get("snapshot")?.artifact_paths.snapshot ?? root,
      kpi: `${root}.kpi.json`,
      report: `${root}.report.md`,
      diagnostics: `${root}.diagnostics.json.gz`
    };
  }
  return { missLedger: join(context.workRoot, "miss-ledger.json") };
}

function trackingExtractionResult(
  context: Parameters<DiagnosticLoopAdapters["extraction"]>[0]
): DiagnosticLoopPhaseResult {
  if (context.request.extractionCacheRoot !== undefined) {
    return extractionResultForRoot(context.request, context.request.extractionCacheRoot);
  }
  const cacheRoot = join(context.workRoot, "tracking-extraction-cache");
  const rawJson = '{"signals":[]}';
  const inspected = inspectExtractionRawJson(rawJson);
  const entries = context.request.requestedKeys.map((cacheKey) => ({
    cacheKey,
    model: context.request.model,
    requestProfile: context.request.requestProfile,
    ...inspected
  }));
  for (const entry of entries) {
    writeCachedExtraction(cacheRoot, entry.cacheKey, {
      model: entry.model,
      request_profile: entry.requestProfile,
      cache_key: entry.cacheKey,
      raw_json: rawJson,
      extracted_at: "2026-08-19T00:00:00.000Z"
    });
  }
  writeExtractionCacheManifest(cacheRoot, trackingManifest(context, entries));
  return extractionResultForRoot(context.request, cacheRoot);
}

export function injectedNoProviderReceipt() {
  return {
    schema_version: 1 as const,
    kind: "injected_no_provider_port" as const,
    provider_port: "absent" as const,
    physical_calls: 0 as const
  };
}

function extractionResultForRoot(
  request: DiagnosticLoopRequest,
  cacheRoot: string
): DiagnosticLoopPhaseResult {
  const authority = resolveExtractionCacheIdentity({ ...request, extractionCacheRoot: cacheRoot });
  return {
    contentIdentity: diagnosticAuthorityDigest(authority),
    physicalCalls: 0,
    artifactPaths: { cacheRoot },
    details: {
      extraction_cache_identity: diagnosticAuthorityDigest(authority),
      extraction_cache_authority: authority
    },
    noProviderCallReceipt: injectedNoProviderReceipt()
  };
}

function trackingManifest(
  context: Parameters<DiagnosticLoopAdapters["extraction"]>[0],
  entries: Parameters<typeof computeExtractionContentClosureSha256>[0]
): ExtractionCacheManifestV3 {
  return {
    schema_version: 3,
    extraction_model: context.request.model,
    model_family: context.request.model,
    request_profile: context.request.requestProfile as ExtractionCacheManifestV3["request_profile"],
    provider_url: "https://provider.invalid/v1",
    system_prompt_sha256: context.request.promptDigest,
    cache_key_algo: "diagnostic-test-v1",
    dataset: context.request.variant,
    dataset_revision: context.request.datasetRevision,
    requested_turns: entries.length,
    cached_turns: entries.length,
    coverage: 1,
    storage: "git-tracked",
    built_at: "2026-08-19T00:00:00.000Z",
    builder: "diagnostic-loop-test",
    fill_status: "complete",
    window_offset: context.request.offset ?? 0,
    window_limit: context.request.limit ?? entries.length,
    expected_turns: entries.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(
      entries.map((entry) => entry.cacheKey)
    ),
    content_closure_sha256: computeExtractionContentClosureSha256(entries),
    content_closure_index: buildExtractionContentClosureIndex(entries)
  };
}

async function trackingSnapshotResult(
  context: Parameters<DiagnosticLoopAdapters["snapshot"]>[0]
): Promise<DiagnosticLoopPhaseResult> {
  const snapshot = await writeDiagnosticSnapshotFixture(context.workRoot, "tracking-snapshot");
  const identity = await resolveSnapshotIdentity(snapshot, context.request.variant);
  return {
    contentIdentity: identity.identity_digest,
    physicalCalls: 0,
    artifactPaths: { snapshot },
    details: { ...identity },
    noProviderCallReceipt: injectedNoProviderReceipt()
  };
}

export async function writeDiagnosticSnapshotFixture(
  root: string,
  name: string,
  questionText?: string
): Promise<string> {
  const snapshotPath = join(root, `${name}.db`);
  initDatabase({ filename: snapshotPath }).close();
  const dbBytes = await readFile(snapshotPath);
  const sidecar = currentSnapshotSidecarFor("q-1");
  if (questionText !== undefined) {
    sidecar.questions = sidecar.questions.map((question) => ({
      ...question, question: questionText
    }));
  }
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  const authorityBytes = renderSnapshotExtractionAuthority(
    currentSnapshotExtractionAuthority()
  );
  const baseManifest = currentSnapshotManifestFor("q-1", {
    db_sha256: sha(dbBytes),
    sidecar_sha256: sha(sidecarBytes),
    extraction_authority_filename: `${name}.db.extraction-authority.json`,
    extraction_authority_sha256: sha(authorityBytes),
    extraction_authority_bytes: authorityBytes.byteLength
  });
  const manifest = {
    ...baseManifest,
    db_filename: `${name}.db`,
    sidecar_filename: `${name}.db.sidecar.json`
  };
  await Promise.all([
    writeFile(`${snapshotPath}.sidecar.json`, sidecarBytes),
    writeFile(`${snapshotPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(`${snapshotPath}.extraction-authority.json`, authorityBytes)
  ]);
  return snapshotPath;
}

export async function writeQueryFactorCacheFixture(
  path: string,
  sourceText: string
): Promise<void> {
  const identity = loopIdentity();
  const capture = materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: sourceText
  });
  await writeQuerySemanticFactorCache(path, createQuerySemanticFactorCache({
    model_id: identity.model,
    request_profile: identity.requestProfile as "mimo-v2.5-nonthinking-v1",
    provider_url: identity.providerRoute,
    entries: [{ source_text: sourceText, source_sha256: capture.source_sha256!, capture }]
  }));
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
