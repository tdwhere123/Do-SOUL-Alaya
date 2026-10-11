import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { inspectCachedSourceSemantic, proposalForRequest } from "../extraction/cache/source-semantic-artifact.js";
import { readCompletePhysicalSourceResponseForRequest,
  readCompleteRetainedSourceResponse } from "../extraction/cache/source-interactive-binding.js";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { parseExtractionOpenSemanticsGeneration } from "../extraction/request-artifact.js";
import { receiveSourceSemanticBatchLine } from "../extraction/fill/batch/source-semantic-interpretation.js";
import { censusNativeSourceRecords } from "../snapshot/source-records/census.js";
import { prepareSourcePublicationAssociations } from "../snapshot/source-records/prepare-associations.js";
import { publishSourceSemanticSnapshot, readNativeSourcePublicationReport,
  type SourcePublicationAssociation } from "../snapshot/source-records/publish.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "./contract.js";
import { admitInitialQualified, initialSourceAssociationOwners,
  initialSourcePhysicalOwner } from "./recovery-publication.js";
import { reserveRecoveryEffect } from "./recovery-window.js";
import { reserveRecoveryRead, reserveRecoveryHostEffect } from "./recovery-allowance.js";
import type { RecoveryWindow } from "./recovery-window.js";
import type { SourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import type { SourceRequestLine } from "../extraction/request-artifact.js";

const FinalQualifiedSchema = z.object({ contract: z.literal("source-semantic-final-qualified-v1"),
  source_outcome: z.enum(["child_published", "initial_reused_terminal_child"]),
  initial_publication_identity: z.string(), revision_identity: z.string(),
  source_preflight_identity: z.string(), source_preflight_path: z.string(), source_cache_root: z.string(),
  source_physical_preflight_identity: z.string(), source_physical_preflight_path: z.string(),
  association_identity: z.string(), snapshot_path: z.string(), snapshot_sha256: z.string(),
  publication_identity: z.string(), active_selected_keys: z.array(z.object({ source_id: z.string(),
    source_version: z.string(), record_id: z.string(), generation_key: z.string() }).strict()),
  descriptor_export: z.array(z.object({ source_id: z.string(), source_version: z.string(),
    record_id: z.string(), generation_key: z.string(),
    descriptor: z.object({ source_interpretation_id: z.string(), interpretation: z.unknown() }).strict()
  }).strict()).max(10)
}).strict();

/** The physical raw parser owns terminal meaning; a missing/corrupt admitted cache cannot turn interpreted H into rejection. */
function terminalChildInterpreted(window: RecoveryWindow, source: RecoveryWindow["window"][number],
  preflight: SourceSemanticInteractivePreflight, physicalPreflight: SourceSemanticInteractivePreflight,
  line: SourceRequestLine, cacheRoot: string): boolean {
  const raw = readCompletePhysicalSourceResponseForRequest({ cacheRoot, currentPreflight: preflight,
    physicalPreflight, currentLine: line });
  const occurrence = censusNativeSourceRecords({ population: window.population,
    snapshotPath: window.native_snapshot_path }).records.find(row => row.source_id === source.source_id &&
      row.source_version === source.source_version && row.native_record_id === source.record_id &&
      row.content_digest === source.content_digest);
  if (occurrence === undefined) throw new AlayaError("CONFLICT", "H child source occurrence changed");
  return interpretCompleteRecoverySourceChild({ model: window.source_model,
    requestProfile: window.source_request_profile, cacheRoot, line, raw,
    sourceCorpus: occurrence.content_bytes });
}

/** Physical receiver outcome, checked against the admitted cache, owns H-child settlement. */
export function interpretCompleteRecoverySourceChild(input: Readonly<{
  model: string; requestProfile: RecoveryWindow["source_request_profile"]; cacheRoot: string; line: SourceRequestLine;
  raw: string; sourceCorpus: string;
}>): boolean {
  const { model, requestProfile, cacheRoot, line, raw, sourceCorpus } = input;
  const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
  const parsed = receiveSourceSemanticBatchLine({ config: { model,
    requestProfile }, line, rawJson: raw,
    sourceCorpus, proposal: proposalForRequest(sourceCorpus, request) });
  const cached = inspectCachedSourceSemantic(cacheRoot, line.key, model, requestProfile);
  if (cached.status === "pending" || cached.status === "hit" &&
      cached.admitted.outcome.status !== parsed.outcome.status ||
      parsed.outcome.status === "interpreted" && cached.status !== "hit") {
    throw new AlayaError("CONFLICT", "H child physical outcome differs from its retained admission");
  }
  return parsed.outcome.status === "interpreted";
}

export function admitFinalRecoveryQualified(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "admit final qualified H publication");
  const { window, settled } = admitInitialQualified(root);
  const final = FinalQualifiedSchema.parse(readChainArtifact(join(root, "final-qualified.json")));
  const revision = readChainArtifact(join(root, "source-revision.json"));
  const preflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: final.source_preflight_path, maxBytes: 32 * 1024 * 1024, label: "retained H child preflight" })));
  const physicalPreflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: final.source_physical_preflight_path, maxBytes: 32 * 1024 * 1024,
    label: "retained H child physical preflight" })));
  const childKey = (revision as { child_key?: string } | undefined)?.child_key;
  const childLine = preflight.ready_requests.find(row => row.key === childKey);
  const associations = readChainArtifact(join(root, "final-associations.json"));
  if (revision === undefined || childLine === undefined ||
      final.revision_identity !== chainIdentity(revision) ||
      final.source_preflight_identity !== chainIdentity(preflight) ||
      final.source_physical_preflight_identity !== chainIdentity(physicalPreflight) ||
      (final.source_outcome === "child_published" &&
        (associations === undefined || final.association_identity !== chainIdentity(associations))) ||
      (final.source_outcome === "initial_reused_terminal_child" &&
        final.association_identity !== settled.association_identity)) {
    throw new AlayaError("CONFLICT", "final H lineage or admitted child cache changed");
  }
  const selected = window.window.find(row => row.source_id === (revision as { source_id?: string }).source_id &&
    row.source_version === (revision as { source_version?: string }).source_version &&
    row.record_id === (revision as { record_id?: string }).record_id);
  if (selected === undefined) throw new AlayaError("CONFLICT", "H child lost its frozen source tuple");
  const retainedRevision = revision as { parent_key?: string; parent_cache_root?: string;
    parent_preflight_path?: string };
  const parentOwner = initialSourcePhysicalOwner(settled, retainedRevision.parent_key ?? "");
  if (retainedRevision.parent_cache_root !== parentOwner.cacheRoot ||
      retainedRevision.parent_preflight_path !== parentOwner.preflightPath) {
    throw new AlayaError("CONFLICT", "final H child lost its immediate physical parent");
  }
  const childInterpreted = terminalChildInterpreted(window, selected, preflight,
    physicalPreflight, childLine, final.source_cache_root);
  if (final.source_outcome === "child_published" ? !childInterpreted : childInterpreted) {
    throw new AlayaError("CONFLICT", "final H child disposition changed after settlement");
  }
  const report = readNativeSourcePublicationReport(final.snapshot_path, window.native_snapshot_path);
  const exported = report.sources.flatMap(source => source.correspondence_descriptor === undefined ? [] : [{
    source_id: source.source_id, source_version: source.source_version, record_id: source.record_id,
    generation_key: source.source_interpretation_generation_key!, descriptor: source.correspondence_descriptor
  }]);
  if (final.initial_publication_identity !== settled.publication_identity ||
      final.snapshot_sha256 !== report.db_sha256 || final.publication_identity !== chainIdentity(report) ||
      canonicalJson(final.descriptor_export) !== canonicalJson(exported) ||
      (final.source_outcome === "initial_reused_terminal_child" &&
        (final.snapshot_path !== settled.snapshot_path || final.publication_identity !== settled.publication_identity)) ||
      final.active_selected_keys.some(row => !report.sources.some(source => source.source_id === row.source_id &&
        source.source_version === row.source_version && source.record_id === row.record_id &&
        source.source_interpretation_generation_key === row.generation_key))) {
    throw new AlayaError("CONFLICT", "final qualified H differs from sealed native publication");
  }
  return { window, initial: settled, final, report };
}

type FinalPublicationInput = Readonly<{
  root: string; childPreflightPath: string; childCacheRoot: string;
  childPhysicalPreflightPath?: string;
}>;

function admitFinalChildForPublication(input: FinalPublicationInput) {
  const root = resolve(input.root);
  reserveRecoveryRead(root, "publish final H inputs", [input.childPreflightPath,
    ...(input.childPhysicalPreflightPath === undefined ? [] : [input.childPhysicalPreflightPath])]);
  const { window, settled, report: initialReport } = admitInitialQualified(root);
  const revision = readChainArtifact(join(root, "source-revision.json")) as {
    source_id?: string; source_version?: string; record_id?: string;
    parent_key?: string; parent_cache_root?: string; parent_preflight_path?: string;
    child_key?: string; generation_path?: string } | undefined;
  const selected = window.window.find(row => row.source_id === revision?.source_id &&
    row.source_version === revision?.source_version && row.record_id === revision?.record_id &&
    row.initial_key === revision?.parent_key);
  if (selected === undefined || revision?.child_key === undefined || revision.generation_path === undefined) {
    throw new AlayaError("CONFLICT", "final H publication lacks a frozen source-local child");
  }
  const generation = parseExtractionOpenSemanticsGeneration(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: revision.generation_path, maxBytes: 1_000_000, label: "source revision generation" })));
  const preflightPath = resolve(input.childPreflightPath), cacheRoot = resolve(input.childCacheRoot);
  const physicalPreflightPath = resolve(input.childPhysicalPreflightPath ?? input.childPreflightPath);
  const preflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: preflightPath, maxBytes: 32 * 1024 * 1024, label: "H child preflight" })));
  const physicalPreflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: physicalPreflightPath, maxBytes: 32 * 1024 * 1024, label: "H child physical preflight" })));
  if (preflight.config.model !== window.source_model ||
      preflight.config.requestProfile !== window.source_request_profile ||
      preflight.dataset_revision !== window.source_census_identity ||
      canonicalJson(parseExtractionOpenSemanticsGeneration(preflight.config.openSemantics)) !== canonicalJson(generation) ||
      preflight.maximum_attempts_per_key !== 1 || preflight.ready_requests.length !== 1 ||
      preflight.ready_requests[0]?.key !== revision.child_key ||
      preflight.selected_requests !== (preflightPath === physicalPreflightPath ? 1 : 0) ||
      preflight.cached_requests !== (preflightPath === physicalPreflightPath ? 0 : 1)) {
    throw new AlayaError("CONFLICT", "H child preflight exceeds its one selected revised source key");
  }
  const childLine = preflight.ready_requests[0]!;
  const child = parseSourceSemanticRequest(JSON.parse(childLine.userPrompt));
  const physicalOwner = initialSourcePhysicalOwner(settled, revision.parent_key!);
  if (revision.parent_cache_root !== physicalOwner.cacheRoot ||
      revision.parent_preflight_path !== physicalOwner.preflightPath) {
    throw new AlayaError("CONFLICT", "H revision changed its immediate physical parent owner");
  }
  const parentPreflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: physicalOwner.preflightPath, maxBytes: 32 * 1024 * 1024, label: "H parent preflight" })));
  const parentLine = parentPreflight.ready_requests.find(row => row.key === revision.parent_key);
  if (parentLine === undefined || child.source_request.revision?.parent_request_json !== parentLine.userPrompt ||
      child.source_request.revision.previous_response !== readCompleteRetainedSourceResponse({
        cacheRoot: physicalOwner.cacheRoot, preflight: parentPreflight, line: parentLine })) {
    throw new AlayaError("CONFLICT", "H child no longer follows its complete selected physical parent");
  }
  const childInterpreted = terminalChildInterpreted(window, selected, preflight,
    physicalPreflight, childLine, cacheRoot);
  return { root, window, settled, initialReport, revision, selected, generation,
    preflightPath, physicalPreflightPath, cacheRoot, preflight, physicalPreflight, childInterpreted };
}

/** Only the selected source takes its physical H child; the rest retain their original H keys. */
export async function publishFinalRecoverySemantics(input: FinalPublicationInput) {
  const admitted = admitFinalChildForPublication(input);
  const { root, window, settled, initialReport, revision, selected, generation,
    preflightPath, physicalPreflightPath, cacheRoot, preflight, physicalPreflight, childInterpreted } = admitted;
  const prior = readChainArtifact(join(root, "final-qualified.json"));
  if (prior !== undefined) {
    const final = admitFinalRecoveryQualified(root).final;
    if (final.source_preflight_path !== preflightPath || final.source_cache_root !== cacheRoot ||
        final.source_physical_preflight_path !== physicalPreflightPath ||
        final.source_preflight_identity !== chainIdentity(preflight) ||
        final.source_physical_preflight_identity !== chainIdentity(physicalPreflight) ||
        final.revision_identity !== chainIdentity(revision)) {
      throw new AlayaError("CONFLICT", "reopened final publication used a different H child authority");
    }
    return final;
  }
  if (!childInterpreted) {
    const activeSelected = initialReport.sources.flatMap(source =>
      source.source_interpretation_generation_key === undefined ||
      !window.window.some(row => row.source_id === source.source_id && row.record_id === source.record_id)
        ? [] : [{ source_id: source.source_id, source_version: source.source_version,
          record_id: source.record_id, generation_key: source.source_interpretation_generation_key }]);
    const result = FinalQualifiedSchema.parse({ contract: "source-semantic-final-qualified-v1",
      source_outcome: "initial_reused_terminal_child", initial_publication_identity: settled.publication_identity,
      revision_identity: chainIdentity(revision), source_preflight_identity: chainIdentity(preflight),
      source_preflight_path: preflightPath, source_cache_root: cacheRoot,
      source_physical_preflight_path: physicalPreflightPath,
      source_physical_preflight_identity: chainIdentity(physicalPreflight),
      association_identity: settled.association_identity, snapshot_path: settled.snapshot_path,
      snapshot_sha256: settled.snapshot_sha256, publication_identity: settled.publication_identity,
      active_selected_keys: activeSelected, descriptor_export: settled.descriptor_export });
    writeChainArtifact(join(root, "final-qualified.json"), result);
    return result;
  }
  return publishInterpretedChild(admitted);
}

async function publishInterpretedChild(admitted: ReturnType<typeof admitFinalChildForPublication>) {
  const { root, window, settled, initialReport, revision, selected, generation,
    preflightPath, physicalPreflightPath, cacheRoot, preflight, physicalPreflight } = admitted;
  if (revision.child_key === undefined) throw new AlayaError("CONFLICT", "interpreted H child lacks its exact request key");
  const owners = [...initialSourceAssociationOwners(settled.source_owners),
    { cacheRoot, retainedPreparationPath: preflightPath,
      ...(preflightPath === physicalPreflightPath ? {} : { physicalPreparationPath: physicalPreflightPath }) }];
  const associationsPath = join(root, "final-associations.json");
  const associationIdentity = chainIdentity({ window: chainIdentity(window), revision: chainIdentity(revision),
    owners: owners.map(row => ({ ...row })) });
  reserveRecoveryHostEffect(root, "final-association", associationIdentity,
    readChainArtifact(associationsPath) !== undefined);
  reserveRecoveryEffect(join(root, "final-association.reserved.json"), associationIdentity,
    readChainArtifact(associationsPath) !== undefined);
  const associations = await prepareSourcePublicationAssociations({ name: window.population,
    nativeSnapshotPath: window.native_snapshot_path, model: window.source_model,
    requestProfile: window.source_request_profile,
    openSemantics: parseExtractionOpenSemanticsGeneration(window.open_semantics),
    activeRevision: { kind: "native", source_id: selected.source_id, source_version: selected.source_version,
      record_id: selected.record_id, key: revision.child_key, generation } }, owners, associationsPath);
  const frozen = new Map(window.window.map(row => [row.source_id, row]));
  const active = associations.publicationAssociations.filter((row): row is Extract<SourcePublicationAssociation,
    { generation_key: string }> => "generation_key" in row).filter(row => {
      const source = frozen.get(row.source_id);
      return source !== undefined && source.source_version === row.source_version &&
        row.generation_key === (source.source_id === selected.source_id ? revision.child_key : source.initial_key);
    });
  const activeSelected = active.map(row => {
    const source = frozen.get(row.source_id)!;
    return { source_id: row.source_id, source_version: row.source_version,
      record_id: source.record_id, generation_key: row.generation_key };
  });
  if (!active.some(row => row.source_id === selected.source_id && row.generation_key === revision.child_key) ||
      active.some(row => !frozen.has(row.source_id))) {
    throw new AlayaError("CONFLICT", "H child qualification escaped its exact frozen source tuple");
  }
  for (const source of window.window) {
    const prior = initialReport.sources.find(row => row.source_id === source.source_id &&
      row.source_version === source.source_version && row.record_id === source.record_id);
    if (prior?.source_interpretation !== "interpreted") continue;
    const key = source.source_id === selected.source_id ? revision.child_key : source.initial_key;
    if (key === null || !active.some(row => row.source_id === source.source_id &&
        row.source_version === source.source_version && row.generation_key === key)) {
      throw new AlayaError("CONFLICT", "final source associations dropped an unrevised qualified occurrence");
    }
  }
  const snapshotPath = join(root, "final-qualified.sqlite");
  reserveRecoveryHostEffect(root, "final-publication", chainIdentity({ associationIdentity, active }),
    existsSync(snapshotPath));
  reserveRecoveryEffect(join(root, "final-publication.reserved.json"),
    chainIdentity({ associationIdentity, active }), existsSync(snapshotPath));
  if (!existsSync(snapshotPath)) await publishSourceSemanticSnapshot({ snapshotPath,
    dataDirRoot: join(root, "final-publication-runtime"), recordedAt: window.recorded_at,
    producerCommit: window.producer_commit, workspaceId: initialReport.workspace_id, runId: initialReport.run_id,
    descriptorExportSourceIds: window.window.map(row => row.source_id),
    populations: [{ name: window.population, nativeSnapshotPath: window.native_snapshot_path,
      model: window.source_model, requestProfile: window.source_request_profile,
      openSemantics: parseExtractionOpenSemanticsGeneration(window.open_semantics),
      cacheRoots: owners.map(row => row.cacheRoot), publicationAssociations: active }] });
  const report = readNativeSourcePublicationReport(snapshotPath, window.native_snapshot_path);
  const exported = report.sources.flatMap(source => source.correspondence_descriptor === undefined ? [] : [{
    source_id: source.source_id, source_version: source.source_version, record_id: source.record_id,
    generation_key: source.source_interpretation_generation_key!, descriptor: source.correspondence_descriptor
  }]);
  const result = FinalQualifiedSchema.parse({ contract: "source-semantic-final-qualified-v1",
    source_outcome: "child_published",
    initial_publication_identity: settled.publication_identity, revision_identity: chainIdentity(revision),
    source_preflight_identity: chainIdentity(preflight), source_preflight_path: preflightPath,
    source_cache_root: cacheRoot, source_physical_preflight_path: physicalPreflightPath,
    source_physical_preflight_identity: chainIdentity(physicalPreflight),
    association_identity: chainIdentity(associations),
    snapshot_path: snapshotPath, snapshot_sha256: report.db_sha256,
    publication_identity: chainIdentity(report), active_selected_keys: activeSelected, descriptor_export: exported });
  writeChainArtifact(join(root, "final-qualified.json"), result);
  return result;
}
