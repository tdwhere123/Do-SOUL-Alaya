import { assertCacheOnlyEnvironment } from "../snapshot/current/current-substrate-authority.js";
import { readExtractionCacheManifest } from "../extraction/cache/extraction-cache-manifest.js";
import { proveCacheOnlyExtraction } from "./cache-only.js";
import { DiagnosticLoopFailure } from "./failures.js";
import { sha256Utf8 } from "./identity.js";
import {
  runProductionMissLedgerPhase,
  runProductionRecallPhase
} from "./production-recall.js";
import { runProductionSnapshotPhase } from "./production-snapshot.js";
import type {
  DiagnosticLoopAdapters,
  DiagnosticLoopPhaseContext,
  DiagnosticLoopPhaseResult
} from "./types.js";

export function createProductionDiagnosticLoopAdapters(
  env: Readonly<Record<string, string | undefined>> = process.env
): DiagnosticLoopAdapters {
  return {
    preflight: (context) => Promise.resolve(runPreflightPhase(context, env)),
    authority_cache: (context) => Promise.resolve(runAuthorityCachePhase(context)),
    extraction: (context) => Promise.resolve(proveCacheOnlyExtraction(context.request)),
    snapshot: runProductionSnapshotPhase,
    control_recall: (context) => runProductionRecallPhase(context, "control"),
    treatment_recall: (context) => runProductionRecallPhase(context, "treatment"),
    miss_ledger: runProductionMissLedgerPhase
  };
}

export function runPreflightPhase(
  context: DiagnosticLoopPhaseContext,
  env: Readonly<Record<string, string | undefined>>
): DiagnosticLoopPhaseResult {
  assertCacheOnlyEnvironment(env);
  if (context.request.worker && env.ALAYA_GARDEN_PROVIDER_KIND !== "host_worker") {
    throw new DiagnosticLoopFailure({
      phase: "preflight",
      classification: "infrastructure",
      message: "worker smoke/run requires ALAYA_GARDEN_PROVIDER_KIND=host_worker",
      resumeCommand: ""
    });
  }
  return {
    contentIdentity: sha256Utf8(JSON.stringify({
      datasetRevision: context.request.datasetRevision,
      requestedKeys: context.request.requestedKeys,
      model: context.request.model,
      requestProfile: context.request.requestProfile,
      worker: context.request.worker,
      cacheMode: context.request.cacheMode
    })),
    physicalCalls: 0,
    artifactPaths: {},
    details: { cache_mode: context.request.cacheMode }
  };
}

export function runAuthorityCachePhase(
  context: DiagnosticLoopPhaseContext
): DiagnosticLoopPhaseResult {
  const cacheRoot = context.request.extractionCacheRoot;
  if (cacheRoot === undefined) {
    throw new DiagnosticLoopFailure({
      phase: "authority_cache",
      classification: "authority",
      message: "authority/cache phase requires --extraction-cache-root",
      resumeCommand: ""
    });
  }
  const manifest = readExtractionCacheManifest(cacheRoot);
  if (manifest === undefined) {
    throw new DiagnosticLoopFailure({
      phase: "authority_cache",
      classification: "authority",
      message: `extraction cache manifest missing at ${cacheRoot}`,
      resumeCommand: ""
    });
  }
  const mismatches = manifestMismatches(manifest, context.request);
  if (mismatches.length > 0) {
    throw new DiagnosticLoopFailure({
      phase: "authority_cache",
      classification: "authority",
      message: `cache identity mismatch: ${mismatches.join(", ")}`,
      resumeCommand: ""
    });
  }
  return {
    contentIdentity: sha256Utf8(JSON.stringify({
      model: manifest.extraction_model,
      requestProfile: "request_profile" in manifest ? manifest.request_profile : "",
      datasetRevision: manifest.dataset_revision,
      promptDigest: manifest.system_prompt_sha256
    })),
    physicalCalls: 0,
    artifactPaths: { cacheRoot },
    details: { dataset_revision: manifest.dataset_revision }
  };
}

function manifestMismatches(
  manifest: {
    readonly extraction_model: string;
    readonly dataset_revision: string;
    readonly system_prompt_sha256: string;
    readonly request_profile?: string;
  },
  request: DiagnosticLoopPhaseContext["request"]
): readonly string[] {
  const mismatches: string[] = [];
  if (manifest.extraction_model !== request.model) mismatches.push("model");
  if (manifest.dataset_revision !== request.datasetRevision) {
    mismatches.push("dataset_revision");
  }
  if (manifest.system_prompt_sha256 !== request.promptDigest) {
    mismatches.push("prompt_digest");
  }
  if (manifest.request_profile !== undefined &&
      manifest.request_profile !== request.requestProfile) {
    mismatches.push("request_profile");
  }
  return mismatches;
}
