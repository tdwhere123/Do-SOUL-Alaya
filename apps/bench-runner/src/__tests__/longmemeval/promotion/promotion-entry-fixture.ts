import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLongMemEvalSelectionContractIdentity,
  KpiPayloadSchema
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
  const root = await mkdtemp(path.join(tmpdir(), "promotion-entry-"));
  roots.push(root);
  const entryRoot = path.join(root, "entry");
  await mkdir(entryRoot, { recursive: true });
  const collected = [question("q-1", 10), question("q-2", 20)];
  const questions = collected.map((row) => canonicalQuestion(row.questionId));
  const selection = createLongMemEvalSelectionContractIdentity({
    datasetSha256: DATASET_SHA,
    assignments: collected.map((row) => ({
      question_id: row.questionId,
      dataset_cohort: "answerable" as const
    }))
  });
  const snapshotProvenance = driftExtractionAuthority(
    runProvenance(
      selection,
      SNAPSHOT_GATE_SHA,
      questions,
      snapshotOptions.producerEnvOverride
    ),
    snapshotOptions.extractionAuthorityDrift
  );
  const snapshotFixture = await writeSnapshotFixture(
    root,
    collected,
    selection,
    snapshotProvenance,
    questions,
    snapshotOptions
  );
  const provenance = runProvenance(selection, GATE_SHA, questions);
  const runtime = runtimeAttribution(
    selection.selected_id_digest,
    provenance,
    snapshotFixture.manifestSha256,
    snapshotBindingGate,
    snapshotFixture.schemaMigrationVersion
  );
  const snapshot = snapshotFixture.manifest;
  const payload = KpiPayloadSchema.parse(assembleRecallEvalKpi({
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
  const report = "# report\n";
  const sidecars = buildRecallEvalArchiveBundle({
    slug: "promotion-entry",
    payload,
    report,
    findings: null,
    collected,
    manifest: snapshot,
    runtimeAttribution: runtime,
    offset: 0,
    limit: null,
    runProvenance: provenance,
    expectedQuestionIdDigest: selection.selected_id_digest,
    provenanceComplete: true
  });
  await Promise.all([
    writeFile(path.join(entryRoot, "kpi.json"), `${JSON.stringify(payload, null, 2)}\n`),
    writeFile(path.join(entryRoot, "report.md"), report),
    ...sidecars.map((sidecar) =>
      writeFile(path.join(entryRoot, sidecar.filename), sidecar.contents))
  ]);
  const verifiedSnapshot = await verifyPromotionSnapshot({
    contractRoot: root,
    snapshot: {
      db_path: "snapshot.db",
      manifest_sha256: snapshotFixture.manifestSha256
    },
    expectedSelection: selection,
    expectedQuestions: questions,
    variant: "longmemeval_s",
    code: {
      commit_sha: COMMIT_SHA,
      commit_sha7: COMMIT_SHA7,
      worktree_state_sha256: WORKTREE_SHA,
      executed_dist: EXECUTED_DIST
    }
  });
  return { entryRoot, selection, snapshot: verifiedSnapshot };
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
  writeEntryFixture
};
