import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLongMemEvalSelectionContractIdentity,
  KpiPayloadSchema,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  extractionContentClosureEntriesFromIndex
} from "../../../longmemeval/extraction/content-closure.js";
import { assembleRecallEvalKpi } from "../../../longmemeval/kpi/recall-eval-payload.js";
import {
  buildLongMemEvalEvidenceManifest,
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceManifest
} from "../../../longmemeval/provenance/evidence-manifest.js";
import {
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../../../longmemeval/provenance/run.js";
import { buildRecallEvalArchiveBundle } from "../../../longmemeval/provenance/recall-eval/recall-eval-archive-bundle.js";
import { withRecallEvalDiagnosticsSpool } from
  "../../../longmemeval/provenance/recall-eval/recall-eval-diagnostics-spool.js";
import { verifyPromotionSnapshot } from "../../../longmemeval/promotion/verifiers/snapshot-verifier.js";
import {
  canonicalQuestion,
  COMMIT_SHA,
  COMMIT_SHA7,
  DATASET_SHA,
  EXECUTED_DIST,
  GATE_SHA,
  question,
  runProvenance,
  runtimeAttribution,
  sha256,
  SNAPSHOT_GATE_SHA,
  WORKTREE_SHA,
  type SnapshotFixtureOptions
} from "./promotion-entry-primitives-fixture.js";
import { writeSnapshotFixture } from
  "./promotion-entry-snapshot-fixture.js";

const roots: string[] = [];

async function cleanupPromotionEntryFixtureRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
}

async function writeEntryFixture(
  snapshotBindingGate = SNAPSHOT_GATE_SHA,
  snapshotOptions: SnapshotFixtureOptions = {}
) {
  const fixture = await preparePromotionEntryFixture(
    snapshotBindingGate, snapshotOptions
  );
  const report = "# report\n";
  const archive = await buildFixtureArchive({
    slug: "promotion-entry", historyRoot: fixture.root,
    payload: fixture.payload, report, findings: null,
    collected: fixture.collected, manifest: fixture.snapshot,
    runtimeAttribution: fixture.runtime, offset: 0, limit: null,
    runProvenance: fixture.provenance,
    expectedQuestionIdDigest: fixture.selection.selected_id_digest,
    provenanceComplete: true
  });
  await persistPromotionEntry(fixture, archive, report);
  const verifiedSnapshot = await verifyPromotionEntrySnapshot(fixture);
  return {
    entryRoot: fixture.entryRoot,
    selection: fixture.selection,
    snapshot: verifiedSnapshot,
    archive: {
      diagnosticsFilename: archive.diagnosticsFilename,
      sidecarFilenames: archive.sidecars.map((sidecar) => sidecar.filename)
    }
  };
}

async function preparePromotionEntryFixture(
  snapshotBindingGate: string,
  snapshotOptions: SnapshotFixtureOptions
) {
  const root = await mkdtemp(path.join(tmpdir(), "promotion-entry-"));
  roots.push(root);
  const entryRoot = path.join(root, "entry");
  await mkdir(entryRoot, { recursive: true });
  const collected = [question("q-1", 10), question("q-2", 20)];
  const questions = collected.map((row) => canonicalQuestion(row.questionId));
  const selection = buildFixtureSelection(collected);
  const snapshotProvenance = withOptionalDistinctProducerCode(driftExtractionAuthority(
    runProvenance(
      selection, SNAPSHOT_GATE_SHA, questions, snapshotOptions.producerEnvOverride
    ),
    snapshotOptions.extractionAuthorityDrift
  ), snapshotOptions.distinctProducerCode === true);
  const snapshotFixture = await writeSnapshotFixture(
    root, collected, selection, snapshotProvenance, questions, snapshotOptions
  );
  const provenance = runProvenance(selection, GATE_SHA, questions);
  const runtime = runtimeAttribution(
    selection.selected_id_digest, provenance, snapshotFixture.manifestSha256,
    snapshotBindingGate, snapshotFixture.schemaMigrationVersion,
    snapshotProvenance.code
  );
  const snapshot = snapshotFixture.manifest;
  const payload = buildPromotionEntryPayload(collected, snapshot, runtime);
  return {
    root, entryRoot, collected, questions, selection, snapshotProvenance,
    snapshotFixture, provenance, runtime, snapshot, payload
  };
}

function buildFixtureSelection(collected: ReturnType<typeof question>[]) {
  return createLongMemEvalSelectionContractIdentity({
    datasetSha256: DATASET_SHA,
    assignments: collected.map((row) => ({
      question_id: row.questionId,
      dataset_cohort: "answerable" as const
    }))
  });
}

function buildPromotionEntryPayload(
  collected: ReturnType<typeof question>[],
  snapshot: Awaited<ReturnType<typeof writeSnapshotFixture>>["manifest"],
  runtime: ReturnType<typeof runtimeAttribution>
) {
  return KpiPayloadSchema.parse(assembleRecallEvalKpi({
    collected,
    manifest: snapshot,
    variant: "longmemeval_s",
    runAt: new Date("2026-07-16T00:00:00.000Z"),
    commitSha7: COMMIT_SHA7,
    alayaVersion: "0.3.11",
    policyShape: "stress",
    simulateReport: "none",
    sampleSize: collected.length,
    evaluatedCount: collected.length,
    recallWeightOverrides: undefined,
    embeddingProviderLabel: "none",
    runtimeAttribution: runtime,
    datasetSha256: DATASET_SHA,
    provenanceComplete: true
  }));
}

async function persistPromotionEntry(
  fixture: Awaited<ReturnType<typeof preparePromotionEntryFixture>>,
  archive: Awaited<ReturnType<typeof buildFixtureArchive>>,
  report: string
): Promise<void> {
  await Promise.all([
    writeFile(
      path.join(fixture.entryRoot, "kpi.json"),
      `${JSON.stringify(fixture.payload, null, 2)}\n`
    ),
    writeFile(path.join(fixture.entryRoot, "report.md"), report),
    ...archive.sidecars.map((sidecar) =>
      writeFile(path.join(fixture.entryRoot, sidecar.filename), sidecar.contents)),
    copyFile(
      archive.diagnosticsArtifact.stagedPath,
      path.join(fixture.entryRoot, archive.diagnosticsFilename)
    )
  ]);
}

async function verifyPromotionEntrySnapshot(
  fixture: Awaited<ReturnType<typeof preparePromotionEntryFixture>>
) {
  return verifyPromotionSnapshot({
    contractRoot: fixture.root,
    snapshot: {
      db_path: "snapshot.db",
      manifest_sha256: fixture.snapshotFixture.manifestSha256,
      producer_code: {
        commit_sha: fixture.snapshotProvenance.code.commit_sha,
        commit_sha7: fixture.snapshotProvenance.code.commit_sha7,
        worktree_state_sha256: fixture.snapshotProvenance.code.worktree_state_sha256,
        executed_dist: fixture.snapshotProvenance.code.executed_dist
      }
    },
    expectedSelection: fixture.selection,
    expectedQuestions: fixture.questions,
    variant: "longmemeval_s"
  });
}

async function buildFixtureArchive(
  input: Omit<Parameters<typeof buildRecallEvalArchiveBundle>[0], "diagnosticsSpool">
) {
  return withRecallEvalDiagnosticsSpool(async (diagnosticsSpool) => {
    const collected = await Promise.all(
      input.collected.map((question) => diagnosticsSpool.append(question))
    );
    return buildRecallEvalArchiveBundle({ ...input, collected, diagnosticsSpool });
  });
}

function withOptionalDistinctProducerCode(
  provenance: LongMemEvalRunProvenance,
  distinct: boolean
): LongMemEvalRunProvenance {
  if (!distinct) return provenance;
  const mutable = structuredClone(provenance);
  mutable.code = {
    ...mutable.code,
    commit_sha7: "7654321",
    commit_sha: "7654321" + "2".repeat(33),
    worktree_state_sha256: "7".repeat(64),
    executed_dist: { ...EXECUTED_DIST, sha256: "7".repeat(64) }
  };
  return LongMemEvalRunProvenanceSchema.parse(mutable);
}

function driftExtractionAuthority(
  provenance: LongMemEvalRunProvenance,
  drift: SnapshotFixtureOptions["extractionAuthorityDrift"]
): LongMemEvalRunProvenance {
  if (drift === undefined) return provenance;
  const mutable = structuredClone(provenance);
  const cache = mutable.extraction_cache;
  if (cache?.schema_version !== 3) throw new Error("fixture requires v3 extraction");
  if (drift === "expected_turns") {
    cache.content_closure_index = {
      ...cache.content_closure_index,
      [sha256("inflated closure member")]: [sha256("inflated raw response"), 0, 0]
    };
    cache.expected_turns = (cache.expected_turns ?? 0) + 1;
    cache.requested_turns = cache.expected_turns;
    cache.cached_turns = cache.expected_turns;
    rebindCacheClosure(cache);
  }
  if (drift === "content_closure") {
    const cacheKey = Object.keys(cache.content_closure_index ?? {})[0]!;
    const row = cache.content_closure_index![cacheKey]!;
    cache.content_closure_index = {
      ...cache.content_closure_index,
      [cacheKey]: ["0".repeat(64), row[1], row[2]]
    };
    rebindCacheClosure(cache);
  }
  if (drift === "window") cache.window_limit = (cache.window_limit ?? 0) + 1;
  return LongMemEvalRunProvenanceSchema.parse(mutable);
}

function rebindCacheClosure(
  cache: NonNullable<LongMemEvalRunProvenance["extraction_cache"]> & {
    readonly schema_version: 3;
  }
): void {
  const index = cache.content_closure_index!;
  const entries = extractionContentClosureEntriesFromIndex(
    index,
    cache.extraction_model,
    cache.request_profile
  );
  cache.expected_key_set_sha256 = computeExtractionKeySetSha256(Object.keys(index));
  cache.content_closure_sha256 = computeExtractionContentClosureSha256(entries);
}


async function duplicateFirstRankQuestion(entryRoot: string): Promise<void> {
  const manifestPath = path.join(entryRoot, LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME);
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8")
  ) as LongMemEvalEvidenceManifest;
  const rankArtifact = manifest.artifacts.find((artifact) =>
    artifact.role === "rank_identity");
  if (rankArtifact === undefined) throw new Error("promotion fixture rank identity missing");
  const rankPath = path.join(entryRoot, rankArtifact.path);
  const rank = JSON.parse(await readFile(rankPath, "utf8")) as {
    questions: Array<{ question_id: string; delivered_objects: unknown[] }>;
  };
  rank.questions[1] = structuredClone(rank.questions[0]!);
  await writeFile(rankPath, `${JSON.stringify(rank, null, 2)}\n`, "utf8");
  await rebindEntryManifest(entryRoot);
}

async function mutateKpiAndRebindManifest(
  entryRoot: string,
  mutate: (payload: KpiPayload) => KpiPayload
): Promise<void> {
  const kpiPath = path.join(entryRoot, "kpi.json");
  const payload = KpiPayloadSchema.parse(JSON.parse(await readFile(kpiPath, "utf8")));
  await writeFile(kpiPath, `${JSON.stringify(mutate(payload), null, 2)}\n`, "utf8");
  await rebindEntryManifest(entryRoot);
}

async function rebindEntryManifest(entryRoot: string): Promise<void> {
  const manifestPath = path.join(entryRoot, LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME);
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8")
  ) as LongMemEvalEvidenceManifest;
  const artifacts = await Promise.all(manifest.artifacts.map(async (artifact) => ({
    role: artifact.role,
    path: artifact.path,
    contents: await readFile(path.join(entryRoot, artifact.path))
  })));
  await writeFile(manifestPath, renderLongMemEvalEvidenceManifest(
    buildLongMemEvalEvidenceManifest({
      ...(manifest.profile === undefined ? {} : { profile: manifest.profile }),
      run: manifest.run,
      artifacts
    })
  ));
}


export {
  cleanupPromotionEntryFixtureRoots,
  duplicateFirstRankQuestion,
  mutateKpiAndRebindManifest,
  writeEntryFixture
};
