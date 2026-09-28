import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { parseExtractionOpenSemanticsGeneration } from "../extraction/request-artifact.js";
import { prepareSourcePublicationAssociations, readRetainedSourcePublicationOwners,
  type SourceAssociationCacheOwner } from "../snapshot/source-records/prepare-associations.js";
import { censusNativeSourceRecords } from "../snapshot/source-records/census.js";
import { publishSourceSemanticSnapshot, readNativeSourcePublicationReport,
  type SourcePublicationAssociation } from "../snapshot/source-records/publish.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "./contract.js";
import { admitRecoveryWindow, reserveRecoveryEffect } from "./recovery-window.js";
import { reserveRecoveryRead, reserveRecoveryHostEffect } from "./recovery-allowance.js";
import type { RecoveryWindow } from "./recovery-window.js";

const SourceOwnerSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/u),
  cache_root: z.string().min(1), current_preflight_path: z.string().min(1),
  physical_preflight_path: z.string().min(1).optional() }).strict();
const SourceOwnersSchema = z.array(SourceOwnerSchema).max(10);
type SourceOwner = z.infer<typeof SourceOwnerSchema>;

export function initialSourcePhysicalOwner(settled: z.infer<typeof QualifiedSchema>, key: string) {
  const owner = settled.source_owners.find(row => row.key === key);
  if (owner === undefined) throw new AlayaError("CONFLICT", "selected H key lacks its physical owner");
  return { cacheRoot: owner.cache_root,
    preflightPath: owner.physical_preflight_path ?? owner.current_preflight_path };
}

export function initialSourceAssociationOwners(owners: readonly SourceOwner[]): SourceAssociationCacheOwner[] {
  const byRoot = new Map<string, SourceAssociationCacheOwner>();
  for (const row of owners) {
    const owner = { cacheRoot: row.cache_root, retainedPreparationPath: row.current_preflight_path,
      ...(row.physical_preflight_path === undefined ? {} : {
        physicalPreparationPath: row.physical_preflight_path }) };
    const prior = byRoot.get(row.cache_root);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(owner)) {
      throw new AlayaError("CONFLICT", "one source cache root has conflicting current or physical preflight owners");
    }
    byRoot.set(row.cache_root, owner);
  }
  return [...byRoot.values()];
}

function readSourcePreflight(path: string) {
  return parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: 32 * 1024 * 1024, label: "current source preflight" })));
}

function assertCurrentSourceOwnerGroup(current: ReturnType<typeof readSourcePreflight>,
  window: RecoveryWindow, keys: readonly string[], physicalKeys: readonly string[], maxOutputTokens?: number): void {
  const ready = current.ready_requests.map(row => row.key).sort();
  const planned = new Set(current.planned_requests.map(row => row.key));
  if (current.dataset_revision !== window.source_census_identity ||
      current.config.model !== window.source_model ||
      current.config.requestProfile !== window.source_request_profile ||
      (maxOutputTokens !== undefined && current.max_output_tokens !== maxOutputTokens) ||
      current.maximum_attempts_per_key !== 1 ||
      canonicalJson(ready) !== canonicalJson([...keys].sort()) ||
      current.cached_requests !== physicalKeys.length ||
      current.selected_requests + current.deterministic_requests !== keys.length - physicalKeys.length ||
      physicalKeys.some(key => planned.has(key)) ||
      canonicalJson(parseExtractionOpenSemanticsGeneration(current.config.openSemantics)) !==
        canonicalJson(parseExtractionOpenSemanticsGeneration(window.open_semantics))) {
    throw new AlayaError("CONFLICT", "H preflight differs from its exact new or retained current keys");
  }
}

function admittedInitialSourceOwners(window: RecoveryWindow, defaultPath: string, defaultRoot: string,
  sharedPath?: string): { owners: SourceOwner[]; defaultPreflight: ReturnType<typeof readSourcePreflight> } {
  const defaultPreflight = readSourcePreflight(defaultPath);
  if (defaultRoot !== window.source_cache_root) {
    throw new AlayaError("CONFLICT", "initial H preparation differs from the frozen selected source window");
  }
  const physicalByKey = new Map(window.initial_h_physical_owners.map(row => [row.key, row]));
  const defaultPhysical = defaultPreflight.ready_requests.flatMap(line => {
    const physical = physicalByKey.get(line.key);
    return physical !== undefined && physical.cache_root === defaultRoot ? [line.key] : [];
  });
  if (defaultPreflight.ready_requests.some(line => !window.selected_missing_keys.includes(line.key) &&
      !defaultPhysical.includes(line.key))) {
    throw new AlayaError("CONFLICT", "initial H preparation differs from the frozen selected source window");
  }
  assertCurrentSourceOwnerGroup(defaultPreflight, window,
    defaultPreflight.ready_requests.map(line => line.key), defaultPhysical);
  const owners: SourceOwner[] = defaultPreflight.ready_requests.map(line => ({
    key: line.key, cache_root: defaultRoot, current_preflight_path: defaultPath,
    ...(defaultPhysical.includes(line.key) ? {
      physical_preflight_path: physicalByKey.get(line.key)!.physical_preflight_path } : {}) }));
  const shared = sharedPath === undefined ? [] : SourceOwnersSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: sharedPath, maxBytes: 64 * 1024, label: "shared source physical owners" })));
  if (new Set(shared.map(row => row.key)).size !== shared.length) {
    throw new AlayaError("CONFLICT", "H owner input repeats an exact key");
  }
  const sharedByRoot = new Map<string, SourceOwner[]>();
  for (const row of shared) {
    const physical = physicalByKey.get(row.key);
    const currentPath = resolve(row.current_preflight_path), cacheRoot = resolve(row.cache_root);
    if (physical === undefined ?
        !window.selected_missing_keys.includes(row.key) || row.physical_preflight_path !== undefined :
        cacheRoot !== physical.cache_root ||
          resolve(row.physical_preflight_path ?? "") !== physical.physical_preflight_path) {
      throw new AlayaError("CONFLICT", "H current owner differs from its frozen selected key or physical ownership");
    }
    const owner = { key: row.key, cache_root: cacheRoot, current_preflight_path: currentPath,
      ...(physical === undefined ? {} : { physical_preflight_path: physical.physical_preflight_path }) };
    owners.push(owner);
    sharedByRoot.set(cacheRoot, [...sharedByRoot.get(cacheRoot) ?? [], owner]);
  }
  for (const group of sharedByRoot.values()) {
    const currentPath = group[0]!.current_preflight_path;
    if (group.some(row => row.current_preflight_path !== currentPath) ||
        (group.length > 1 && group.some(row => row.physical_preflight_path === undefined))) {
      throw new AlayaError("CONFLICT", "one source cache root has conflicting current preflight owners");
    }
    assertCurrentSourceOwnerGroup(readSourcePreflight(currentPath), window,
      group.map(row => row.key), group.filter(row => row.physical_preflight_path !== undefined).map(row => row.key),
      defaultPreflight.max_output_tokens);
  }
  const expected = [...window.selected_missing_keys, ...physicalByKey.keys()].sort();
  if (sharedPath !== undefined &&
      canonicalJson(owners.map(row => row.key).sort()) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "H owners omit or repeat a frozen selected request key");
  }
  const parsed = SourceOwnersSchema.parse(owners);
  initialSourceAssociationOwners(parsed);
  return { owners: parsed, defaultPreflight };
}

function admitInitialSourceAssociations(window: RecoveryWindow, owners: readonly SourceOwner[],
  association: unknown): void {
  const census = censusNativeSourceRecords({ population: window.population,
    snapshotPath: window.native_snapshot_path });
  const retained = readRetainedSourcePublicationOwners(initialSourceAssociationOwners(owners), {
    model: window.source_model, requestProfile: window.source_request_profile },
    parseExtractionOpenSemanticsGeneration(window.open_semantics), census.dataset_sha256);
  const report = z.object({ retained_preparations: z.array(z.object({
    cache_root: z.string(), retained_preparation_digest: z.string(),
    physical_preparation_digest: z.string().optional() }).passthrough()) }).passthrough().parse(association);
  const projected = retained.retained.map(row => ({ cache_root: row.cacheRoot,
    retained_preparation_digest: row.digest,
    ...(row.physicalPreparationDigest === undefined ? {} : {
      physical_preparation_digest: row.physicalPreparationDigest }) }));
  const recorded = report.retained_preparations.map(row => ({ cache_root: row.cache_root,
    retained_preparation_digest: row.retained_preparation_digest,
    ...(row.physical_preparation_digest === undefined ? {} : {
      physical_preparation_digest: row.physical_preparation_digest }) }));
  if (canonicalJson(projected) !== canonicalJson(recorded) ||
      canonicalJson([...retained.owned.keys()].sort()) !== canonicalJson([...new Set(owners.map(row => row.key))].sort())) {
    throw new AlayaError("CONFLICT", "initial source association changed its retained physical owner");
  }
}

export const QualifiedSchema = z.object({ contract: z.literal("source-semantic-initial-qualified-v1"),
  window_identity: z.string(), source_preflight_identity: z.string(),
  source_preflight_path: z.string(), source_cache_root: z.string(),
  source_owners: SourceOwnersSchema,
  association_identity: z.string(), snapshot_path: z.string(), snapshot_sha256: z.string(),
  publication_identity: z.string(), published_selected_count: z.number().int().nonnegative(),
  descriptor_export: z.array(z.object({ source_id: z.string(), source_version: z.string(),
    record_id: z.string(), generation_key: z.string(),
    descriptor: z.object({ source_interpretation_id: z.string(), interpretation: z.unknown() }).strict()
  }).strict()).max(10)
}).strict();

export function admitInitialQualified(rootInput: string, readAllowanceRootInput = rootInput) {
  const root = resolve(rootInput);
  const readAllowanceRoot = resolve(readAllowanceRootInput);
  reserveRecoveryRead(readAllowanceRoot, "admit initial qualified publication");
  const window = admitRecoveryWindow(root, readAllowanceRoot);
  const settled = QualifiedSchema.parse(readChainArtifact(join(root, "initial-qualified.json")));
  const defaultPath = resolve(settled.source_preflight_path);
  const defaultRoot = resolve(settled.source_cache_root);
  const admitted = admittedInitialSourceOwners(window, defaultPath, defaultRoot);
  if (settled.source_preflight_identity !== chainIdentity(admitted.defaultPreflight) ||
      canonicalJson(settled.source_owners.filter(row => row.cache_root === defaultRoot &&
        row.current_preflight_path === defaultPath)) !==
        canonicalJson(admitted.owners)) {
    throw new AlayaError("CONFLICT", "initial H default owner changed after qualification");
  }
  const shared = settled.source_owners.filter(row => row.physical_preflight_path !== undefined);
  if (shared.length !== window.initial_h_physical_owners.length ||
      shared.some(row => !window.initial_h_physical_owners.some(physical => physical.key === row.key &&
        physical.cache_root === row.cache_root && physical.physical_preflight_path === row.physical_preflight_path))) {
    throw new AlayaError("CONFLICT", "initial H shared owner changed after qualification");
  }
  if (canonicalJson(settled.source_owners.map(row => row.key).sort()) !==
      canonicalJson([...window.selected_missing_keys,
        ...window.initial_h_physical_owners.map(row => row.key)].sort())) {
    throw new AlayaError("CONFLICT", "initial H owner set changed after qualification");
  }
  admitInitialSourceAssociations(window, settled.source_owners,
    readChainArtifact(join(root, "initial-associations.json")));
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
  root: string; sourcePreflightPath: string; sourceCacheRoot: string; sourceOwnersPath?: string;
}>) {
  const root = resolve(input.root);
  reserveRecoveryRead(root, "publish initial H inputs", [input.sourcePreflightPath,
    ...(input.sourceOwnersPath === undefined ? [] : [input.sourceOwnersPath])]);
  const window = admitRecoveryWindow(root);
  const preflightPath = resolve(input.sourcePreflightPath);
  const cacheRoot = resolve(input.sourceCacheRoot);
  const { owners: sourceOwners, defaultPreflight: preflight } = admittedInitialSourceOwners(window,
    preflightPath, cacheRoot, input.sourceOwnersPath);
  if (canonicalJson(sourceOwners.map(row => row.key).sort()) !== canonicalJson([
    ...window.selected_missing_keys, ...window.initial_h_physical_owners.map(row => row.key)].sort())) {
    throw new AlayaError("CONFLICT", "initial H publication omits a frozen shared physical owner");
  }
  const prior = readChainArtifact(join(root, "initial-qualified.json"));
  if (prior !== undefined) {
    const settled = admitInitialQualified(root).settled;
    if (canonicalJson(settled.source_owners) !== canonicalJson(sourceOwners)) {
      throw new AlayaError("CONFLICT", "initial qualified snapshot changed after settlement");
    }
    return settled;
  }
  const owner = initialSourceAssociationOwners(sourceOwners);
  const associationPath = join(root, "initial-associations.json");
  const associationIdentity = chainIdentity({ window: chainIdentity(window), preflight: chainIdentity(preflight), owner });
  reserveRecoveryHostEffect(root, "initial-association", associationIdentity,
    readChainArtifact(associationPath) !== undefined);
  reserveRecoveryEffect(join(root, "initial-association.reserved.json"), associationIdentity,
    readChainArtifact(associationPath) !== undefined);
  const associations = await prepareSourcePublicationAssociations({ name: window.population,
    nativeSnapshotPath: window.native_snapshot_path, model: window.source_model,
    requestProfile: window.source_request_profile,
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
      model: window.source_model, requestProfile: window.source_request_profile,
      cacheRoots: owner.map(row => row.cacheRoot), publicationAssociations: active }] });
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
    source_owners: sourceOwners,
    association_identity: chainIdentity(associations), snapshot_path: snapshotPath,
    snapshot_sha256: report.db_sha256, publication_identity: chainIdentity(report),
    published_selected_count: exportRows.length, descriptor_export: exportRows });
  writeChainArtifact(join(root, "initial-qualified.json"), result);
  return result;
}
