import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeExtractionCacheAuditArtifact } from
  "../../longmemeval/extraction/cache-audit/receipt.js";
import type { ExtractionOccurrence } from
  "../../longmemeval/extraction/cache-audit/occurrence-index.js";
import type { ExtractionCacheAuditRun } from "./command.js";

export interface ExtractionCacheAuditArtifact {
  readonly name: string;
  readonly contents: string;
}

interface BundleWriterDependencies {
  readonly randomId?: () => string;
  readonly writeArtifact?: (path: string, contents: string) => void;
}

export function writeExtractionCacheAuditBundle(
  run: ExtractionCacheAuditRun,
  dependencies: BundleWriterDependencies = {}
): void {
  publishExtractionCacheAuditBundle(run.auditOutput, [
    { name: "source-manifest.json", contents: run.sourceManifestRaw },
    { name: "raw-inventory.json", contents: renderJson({
      sha256: run.inventorySha256,
      inventory: run.inventory
    }) },
    { name: "occurrence-index.json", contents: renderJson({
      sha256: run.occurrenceIndexSha256,
      occurrences: run.occurrences.map(renderOccurrence)
    }) },
    { name: "replay-ledger.json", contents: renderJson({
      sha256: run.replaySha256,
      closure: run.replay.closure,
      occurrences: run.replay.occurrences.map((occurrence) => ({
        occurrence: renderOccurrence(occurrence.occurrence),
        raw_json_sha256: occurrence.rawJsonSha256,
        entries: occurrence.entries
      }))
    }) },
    { name: "audit-receipt.json", contents: renderJson(run.receipt) }
  ], dependencies);
}

export function publishExtractionCacheAuditBundle(
  output: string,
  artifacts: readonly ExtractionCacheAuditArtifact[],
  dependencies: BundleWriterDependencies = {}
): void {
  const staging = `${output}.${(dependencies.randomId ?? randomUUID)()}.tmp`;
  const writeArtifact = dependencies.writeArtifact ?? writeExtractionCacheAuditArtifact;
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  try {
    for (const artifact of artifacts) {
      assertArtifactName(artifact.name);
      writeArtifact(join(staging, artifact.name), artifact.contents);
    }
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function renderOccurrence(occurrence: ExtractionOccurrence) {
  return {
    id: occurrence.id,
    evidence_ref: occurrence.evidenceRef,
    question_id: occurrence.questionId,
    session_index: occurrence.sessionIndex,
    round_index: occurrence.roundIndex,
    source_observed_at: occurrence.sourceObservedAt,
    turn_content_sha256: hashString(occurrence.turnContent),
    cache_key: occurrence.cacheKey
  };
}

function assertArtifactName(name: string): void {
  if (!/^[a-z][a-z0-9-]*\.json$/u.test(name)) {
    throw new Error("cache audit artifact name must be a flat JSON filename");
  }
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
