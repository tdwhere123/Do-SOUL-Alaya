import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { parseExtractionOpenSemanticsGeneration } from "../extraction/request-artifact.js";
import { prepareSourcePublicationAssociations } from "../snapshot/source-records/prepare-associations.js";
import { publishSourceSemanticSnapshot, readNativeSourcePublicationReport,
  type SourcePublicationAssociation } from "../snapshot/source-records/publish.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "./contract.js";
import { admitRecoveryWindow, reserveRecoveryEffect } from "./recovery-window.js";
import { reserveRecoveryRead, reserveRecoveryHostEffect } from "./recovery-allowance.js";

export const QualifiedSchema = z.object({ contract: z.literal("source-semantic-initial-qualified-v1"),
  window_identity: z.string(), source_preflight_identity: z.string(),
  source_preflight_path: z.string(), source_cache_root: z.string(),
  association_identity: z.string(), snapshot_path: z.string(), snapshot_sha256: z.string(),
  publication_identity: z.string(), published_selected_count: z.number().int().nonnegative(),
  descriptor_export: z.array(z.object({ source_id: z.string(), source_version: z.string(),
    record_id: z.string(), generation_key: z.string(),
    descriptor: z.object({ source_interpretation_id: z.string(), interpretation: z.unknown() }).strict()
  }).strict()).max(10)
}).strict();

export function admitInitialQualified(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "admit initial qualified publication");
  const window = admitRecoveryWindow(root);
  const settled = QualifiedSchema.parse(readChainArtifact(join(root, "initial-qualified.json")));
  const report = readNativeSourcePublicationReport(settled.snapshot_path, window.native_snapshot_path);
  if (settled.window_identity !== chainIdentity(window) || settled.publication_identity !== chainIdentity(report) ||
      settled.snapshot_sha256 !== report.db_sha256 || settled.published_selected_count !== settled.descriptor_export.length ||
      canonicalJson(settled.descriptor_export) !== canonicalJson(report.sources.flatMap(source =>
        source.correspondence_descriptor === undefined ? [] : [{ source_id: source.source_id,
          source_version: source.source_version, record_id: source.record_id,
          generation_key: source.source_interpretation_generation_key!, descriptor: source.correspondence_descriptor }]))) {
    throw new AlayaError("CONFLICT", "initial H export changed after qualified publication");
  }
  return { window, settled, report };
}

/** Initial H is selected by the already frozen native window, then sealed without a second query preparation. */
export async function publishInitialRecoverySemantics(input: Readonly<{
  root: string; sourcePreflightPath: string; sourceCacheRoot: string;
}>) {
  const root = resolve(input.root);
  reserveRecoveryRead(root, "publish initial H inputs", [input.sourcePreflightPath]);
  const window = admitRecoveryWindow(root);
  const preflightPath = resolve(input.sourcePreflightPath);
  const cacheRoot = resolve(input.sourceCacheRoot);
  const preflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: preflightPath, maxBytes: 32 * 1024 * 1024, label: "initial source preflight" })));
  if (cacheRoot !== window.source_cache_root || preflight.config.model !== window.source_model ||
      preflight.config.requestProfile !== window.source_request_profile ||
      preflight.dataset_revision !== window.source_census_identity ||
      canonicalJson(parseExtractionOpenSemanticsGeneration(preflight.config.openSemantics)) !==
        canonicalJson(parseExtractionOpenSemanticsGeneration(window.open_semantics)) ||
      canonicalJson([...preflight.ready_requests.map(line => line.key)].sort()) !==
        canonicalJson(window.selected_missing_keys) ||
      preflight.maximum_attempts_per_key !== 1) {
    throw new AlayaError("CONFLICT", "initial H preparation differs from the frozen selected source window");
  }
  const prior = readChainArtifact(join(root, "initial-qualified.json"));
  if (prior !== undefined) {
    const settled = QualifiedSchema.parse(prior);
    const report = readNativeSourcePublicationReport(settled.snapshot_path, window.native_snapshot_path);
    if (settled.window_identity !== chainIdentity(window) ||
        settled.source_preflight_identity !== chainIdentity(preflight) ||
        settled.publication_identity !== chainIdentity(report) ||
        settled.snapshot_sha256 !== report.db_sha256) {
      throw new AlayaError("CONFLICT", "initial qualified snapshot changed after settlement");
    }
    return settled;
  }
  const owner = [{ cacheRoot, retainedPreparationPath: preflightPath }];
  const associationPath = join(root, "initial-associations.json");
  const associationIdentity = chainIdentity({ window: chainIdentity(window), preflight: chainIdentity(preflight), owner });
  reserveRecoveryHostEffect(root, "initial-association", associationIdentity,
    readChainArtifact(associationPath) !== undefined);
  reserveRecoveryEffect(join(root, "initial-association.reserved.json"), associationIdentity,
    readChainArtifact(associationPath) !== undefined);
  const associations = await prepareSourcePublicationAssociations({ name: window.population,
    nativeSnapshotPath: window.native_snapshot_path, model: window.source_model,
    requestProfile: preflight.config.requestProfile,
    openSemantics: parseExtractionOpenSemanticsGeneration(window.open_semantics) }, owner, associationPath);
  const selected = new Map(window.window.map(row => [row.source_id, row]));
  const active = associations.publicationAssociations.filter((row): row is Extract<SourcePublicationAssociation,
    { generation_key: string }> => "generation_key" in row).filter(row => {
      const frozen = selected.get(row.source_id);
      return frozen !== undefined && frozen.source_version === row.source_version &&
        frozen.initial_key === row.generation_key &&
        (frozen.initial_cache_status === "missing" || frozen.initial_cache_status === "hit");
    });
  if (active.some(row => !selected.has(row.source_id))) throw new AlayaError("INTERNAL", "source selection escaped frozen window");
  const snapshotPath = join(root, "initial-qualified.sqlite");
  reserveRecoveryHostEffect(root, "initial-publication", chainIdentity({ associationIdentity, active }),
    existsSync(snapshotPath));
  reserveRecoveryEffect(join(root, "initial-publication.reserved.json"),
    chainIdentity({ associationIdentity, active }), existsSync(snapshotPath));
  if (!existsSync(snapshotPath)) await publishSourceSemanticSnapshot({ snapshotPath,
    dataDirRoot: join(root, "initial-publication-runtime"), recordedAt: window.recorded_at,
    producerCommit: window.producer_commit,
    workspaceId: readNativeSourcePublicationReport(window.raw_snapshot_path, window.native_snapshot_path).workspace_id,
    runId: readNativeSourcePublicationReport(window.raw_snapshot_path, window.native_snapshot_path).run_id,
    descriptorExportSourceIds: window.window.map(row => row.source_id),
    populations: [{ name: window.population, nativeSnapshotPath: window.native_snapshot_path,
      model: window.source_model, requestProfile: preflight.config.requestProfile,
      cacheRoots: [cacheRoot], publicationAssociations: active }] });
  const report = readNativeSourcePublicationReport(snapshotPath, window.native_snapshot_path);
  const exportRows = report.sources.flatMap(source => source.correspondence_descriptor === undefined ? [] : [{
    source_id: source.source_id, source_version: source.source_version, record_id: source.record_id,
    generation_key: source.source_interpretation_generation_key!, descriptor: source.correspondence_descriptor
  }]);
  if (exportRows.some(row => !active.some(item => item.source_id === row.source_id &&
      item.source_version === row.source_version && item.generation_key === row.generation_key))) {
    throw new AlayaError("CONFLICT", "qualified H descriptor lacks its exact selected source association");
  }
  const result = QualifiedSchema.parse({ contract: "source-semantic-initial-qualified-v1",
    window_identity: chainIdentity(window), source_preflight_identity: chainIdentity(preflight),
    source_preflight_path: preflightPath, source_cache_root: cacheRoot,
    association_identity: chainIdentity(associations), snapshot_path: snapshotPath,
    snapshot_sha256: report.db_sha256, publication_identity: chainIdentity(report),
    published_selected_count: exportRows.length, descriptor_export: exportRows });
  writeChainArtifact(join(root, "initial-qualified.json"), result);
  return result;
}
