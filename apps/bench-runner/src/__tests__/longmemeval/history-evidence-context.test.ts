import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  KpiPayloadSchema,
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";
import { loadMergeShards } from "../../cli/merge-command-shards.js";
import { deriveMergedLongMemEvalReleaseAuthority } from
  "../../cli/merge/release-evidence-authority.js";
import {
  createLongMemEvalHistoryLayout,
  resolveLongMemEvalEvidenceContext
} from
  "../../longmemeval/history/evidence-context.js";
import { LongMemEvalDiagnosticsSpool } from
  "../../longmemeval/diagnostics/spool.js";
import {
  buildLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput,
  type LongMemEvalEvidenceManifest
} from "../../longmemeval/evidence-manifest.js";
import {
  archiveRoot,
  cleanupRoots,
  roots,
  setupShard
} from "../cli/cli-merge-evidence-fixture.js";
import { createMergeDatasetSource } from
  "../cli/cli-merge-dataset-fixture.js";
import { withEligibleMeasurementContract } from
  "../cli/cli-merge-validations-fixture.js";
import {
  createTestLongMemEvalDatasetAuthority,
  deriveLongMemEvalReleaseEvidenceAuthority
} from "../../longmemeval/fetch.js";
import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/internal";

afterEach(cleanupRoots);

describe("LongMemEval history evidence byte revalidation", () => {
  it("revalidates artifact bytes after an earlier successful verification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "history-evidence-context-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const historyRoot = path.join(root, "history");
    const dataset = await createMergeDatasetSource(root);
    await setupShard(shard, "q-history", 0);
    expect(await runCli([
      "merge-longmemeval", "--variant", "s", "--history-root", historyRoot,
      ...dataset.cliArgs,
      "--shards", shard
    ])).toBe(1);
    const entryRoot = await archiveRoot(historyRoot);
    const payload = KpiPayloadSchema.parse(JSON.parse(await readFile(
      path.join(entryRoot, "kpi.json"),
      "utf8"
    )));
    const selection = payload.selection_contract;
    if (selection === undefined || payload.dataset.checksum_sha256 === undefined) {
      throw new Error("fixture requires immutable LongMemEval selection identity");
    }
    const layout = createLongMemEvalHistoryLayout({
      historyRoot,
      authority: testReleaseAuthority(payload, ["q-history"])
    });
    const verify = () => layout.verifyLongMemEvalEvidence!({ entryRoot, payload });
    await expect(verify()).resolves.toBeDefined();

    await appendFile(path.join(entryRoot, "report.md"), "mutated\n", "utf8");

    await expect(verify()).rejects.toThrow(/sha256 mismatch: report\.md/u);
  });
});

describe("LongMemEval merged child provenance binding", () => {
  it("rejects self-consistent merged child provenance identity drift", async () => {
    const fixture = await mergedEvidenceFixture();
    const mutations: ReadonlyArray<readonly [string, (child: MutableChild) => void]> = [
      ["selection", (child) => { child.selection.selected_id_digest = "1".repeat(64); }],
      ["commit", (child) => { child.code.commit_sha = `abc1234${"2".repeat(33)}`; }],
      ["gate", (child) => { child.code.gate_sha256 = "3".repeat(64); }],
      ["worktree", (child) => { child.code.worktree_state_sha256 = "4".repeat(64); }],
      ["extraction", (child) => { child.extraction_cache.system_prompt_sha256 = "5".repeat(64); }],
      ["recall", (child) => { child.recall_config.effective_config_sha256 = "6".repeat(64); }]
    ];
    for (const [label, mutate] of mutations) {
      const artifacts = mutateFirstChild(fixture.artifacts, mutate);
      const manifest = buildLongMemEvalEvidenceManifest({
        profile: fixture.manifest.profile,
        run: fixture.manifest.run,
        artifacts
      });
      const entryRoot = path.join(fixture.root, `mutated-${label}`);
      await writeEvidenceEntry(entryRoot, manifest, artifacts);
      await expect(fixture.verify(entryRoot), label).rejects.toThrow(
        /merged child provenance differs from canonical shard plan/u
      );
    }
  });
});

describe("LongMemEval release authority binding", () => {
  it("rejects a KPI-shaped selection that reorders the authority dataset", async () => {
    const fixture = await mergedEvidenceFixture();
    const datasetAuthority = createTestLongMemEvalDatasetAuthority({
      datasetSha256: fixture.payload.dataset.checksum_sha256!,
      assignments: ["q-a", "q-b"].map((question_id) => ({
        question_id,
        dataset_cohort: "answerable" as const
      }))
    });

    for (const questionIds of [["q-b", "q-a"], ["q-a", "q-missing"]]) {
      expect(() => deriveLongMemEvalReleaseEvidenceAuthority(datasetAuthority, {
        kind: "dataset_order_subset",
        questionIds
      })).toThrow(/does not preserve dataset order/u);
    }
  });

  it("derives sparse merged authority from canonical shard assignments", async () => {
    const fixture = await mergedEvidenceFixture({
      questionIds: ["q-a", "q-history"],
      authorityDatasetOrder: ["q-a", "q-b", "q-history"]
    });

    await expect(fixture.verify(fixture.entryRoot)).resolves.toBeDefined();
  });

  it("rejects a structurally forged release authority", async () => {
    const fixture = await mergedEvidenceFixture();
    const layout = createLongMemEvalHistoryLayout({
      historyRoot: fixture.root,
      authority: {} as LongMemEvalReleaseEvidenceAuthority
    });

    await expect(layout.verifyLongMemEvalEvidence!({
      entryRoot: fixture.entryRoot,
      payload: fixture.payload
    })).rejects.toThrow(/release evidence authority is not verified/u);
  });
});

describe("LongMemEval full diagnostics evidence binding", () => {
  it("refuses a self-consistent full diagnostics artifact with invalid rows", async () => {
    const fixture = await mergedEvidenceFixture();
    const payload = eligibleFixturePayload(fixture.payload);
    const artifacts = bindPayloadArtifact(
      corruptFullDiagnosticsSchema(fixture.artifacts),
      payload
    );
    const manifest = buildLongMemEvalEvidenceManifest({
      profile: fixture.manifest.profile,
      run: fixture.manifest.run,
      artifacts
    });
    const entryRoot = path.join(fixture.root, "invalid-full-diagnostics");
    await writeEvidenceEntry(entryRoot, manifest, artifacts);

    await expect(resolveLongMemEvalEvidenceContext(
      fixture.layout,
      entryRoot,
      payload
    )).resolves.toBeNull();
  });

  it("refuses valid diagnostics rows whose hit aggregate drifts from KPI", async () => {
    const fixture = await mergedEvidenceFixture();
    const payload = eligibleFixturePayload(fixture.payload);
    const artifacts = bindPayloadArtifact(
      mutateFullDiagnostics(fixture.artifacts, (diagnostics) => {
        diagnostics.questions[0]!.hit_at_5 = false;
      }),
      payload
    );
    const manifest = buildLongMemEvalEvidenceManifest({
      profile: fixture.manifest.profile,
      run: fixture.manifest.run,
      artifacts
    });
    const entryRoot = path.join(fixture.root, "drifted-full-diagnostics");
    await writeEvidenceEntry(entryRoot, manifest, artifacts);

    await expect(resolveLongMemEvalEvidenceContext(
      fixture.layout,
      entryRoot,
      payload
    )).resolves.toBeNull();
  });
});

interface MutableChild {
  selection: { selected_id_digest: string };
  code: {
    commit_sha: string;
    gate_sha256: string;
    worktree_state_sha256: string;
  };
  extraction_cache: { system_prompt_sha256: string };
  recall_config: { effective_config_sha256: string };
}

async function mergedEvidenceFixture(input: {
  readonly questionIds?: readonly string[];
  readonly authorityDatasetOrder?: readonly string[];
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "merged-child-binding-"));
  roots.push(root);
  const dataset = await createMergeDatasetSource(root);
  const historyRoot = path.join(root, "history");
  const questionIds = input.questionIds ?? ["q-a", "q-b"];
  const shardRoots = questionIds.map((_, index) => path.join(root, `shard-${index}`));
  await Promise.all(shardRoots.map((shardRoot, index) =>
    setupShard(shardRoot, questionIds[index]!, index)
  ));
  expect(await runCli([
    "merge-longmemeval", "--variant", "s", "--history-root", historyRoot,
    ...dataset.cliArgs,
    "--shards", ...shardRoots
  ])).toBe(1);
  const entryRoot = await archiveRoot(historyRoot);
  const payload = KpiPayloadSchema.parse(JSON.parse(await readFile(
    path.join(entryRoot, "kpi.json"), "utf8"
  )));
  const manifest = JSON.parse(await readFile(
    path.join(entryRoot, "longmemeval-evidence-manifest.json"), "utf8"
  )) as LongMemEvalEvidenceManifest;
  const artifacts = await readManifestArtifacts(entryRoot, manifest);
  const authority = await deriveMergedFixtureAuthority(
    payload,
    input.authorityDatasetOrder ?? questionIds,
    shardRoots
  );
  const layout = createLongMemEvalHistoryLayout({ historyRoot, authority });
  return {
    root,
    entryRoot,
    payload,
    manifest,
    artifacts,
    layout,
    verify: (candidateRoot: string) => layout.verifyLongMemEvalEvidence!({
      entryRoot: candidateRoot,
      payload
    })
  };
}

async function readManifestArtifacts(
  entryRoot: string,
  manifest: LongMemEvalEvidenceManifest
): Promise<LongMemEvalEvidenceArtifactInput[]> {
  return Promise.all(manifest.artifacts.map(async (artifact) => ({
    role: artifact.role,
    path: artifact.path,
    contents: await readFile(path.join(entryRoot, artifact.path))
  })));
}

function corruptFullDiagnosticsSchema(
  artifacts: readonly LongMemEvalEvidenceArtifactInput[]
): LongMemEvalEvidenceArtifactInput[] {
  return mutateFullDiagnostics(artifacts, (diagnostics) => {
    diagnostics.questions[0]!.candidate_pool_complete = "forged";
  });
}

interface MutableFullDiagnostics {
  questions: Array<Record<string, unknown>>;
}

function mutateFullDiagnostics(
  artifacts: readonly LongMemEvalEvidenceArtifactInput[],
  mutate: (diagnostics: MutableFullDiagnostics) => void
): LongMemEvalEvidenceArtifactInput[] {
  return artifacts.map((artifact) => {
    if (artifact.role !== "full_diagnostics") return artifact;
    if (artifact.contents === undefined) throw new Error("diagnostics fixture bytes missing");
    const diagnostics = JSON.parse(
      gunzipSync(artifact.contents).toString("utf8")
    ) as MutableFullDiagnostics;
    mutate(diagnostics);
    return {
      role: artifact.role,
      path: artifact.path,
      contents: gzipSync(`${JSON.stringify(diagnostics)}\n`)
    };
  });
}

function eligibleFixturePayload(payload: KpiPayload): KpiPayload {
  const eligible = withEligibleMeasurementContract(payload);
  return KpiPayloadSchema.parse({
    ...eligible,
    kpi: {
      ...eligible.kpi,
      per_scenario: payload.kpi.per_scenario.map((row) => ({
        ...row,
        scorable: true,
        measurement_cohort: "answerable" as const
      }))
    }
  });
}

function bindPayloadArtifact(
  artifacts: readonly LongMemEvalEvidenceArtifactInput[],
  payload: KpiPayload
): LongMemEvalEvidenceArtifactInput[] {
  return artifacts.map((artifact) => artifact.role === "kpi"
    ? {
        role: artifact.role,
        path: artifact.path,
        contents: `${JSON.stringify(payload, null, 2)}\n`
      }
    : artifact);
}

async function deriveMergedFixtureAuthority(
  payload: KpiPayload,
  authorityDatasetOrder: readonly string[],
  shardRoots: readonly string[]
) {
  const datasetSha256 = payload.dataset.checksum_sha256;
  if (datasetSha256 === undefined) throw new Error("fixture dataset identity missing");
  const datasetAuthority = createTestLongMemEvalDatasetAuthority({
    datasetSha256,
    assignments: authorityDatasetOrder.map((question_id) => ({
      question_id,
      dataset_cohort: "answerable" as const
    }))
  });
  const spool = await LongMemEvalDiagnosticsSpool.create();
  try {
    const loaded = await loadMergeShards(shardRoots, spool);
    return deriveMergedLongMemEvalReleaseAuthority(
      datasetAuthority,
      loaded.archiveRefs
    );
  } finally {
    await spool.dispose();
  }
}

function testReleaseAuthority(
  payload: KpiPayload,
  orderedQuestionIds: readonly string[]
) {
  const datasetSha256 = payload.dataset.checksum_sha256;
  if (datasetSha256 === undefined) throw new Error("fixture dataset identity missing");
  const datasetAuthority = createTestLongMemEvalDatasetAuthority({
    datasetSha256,
    assignments: orderedQuestionIds.map((question_id) => ({
      question_id,
      dataset_cohort: "answerable" as const
    }))
  });
  return deriveLongMemEvalReleaseEvidenceAuthority(datasetAuthority, {
    kind: "execution_window",
    offset: 0,
    limit: orderedQuestionIds.length
  });
}

async function writeEvidenceEntry(
  entryRoot: string,
  manifest: LongMemEvalEvidenceManifest,
  artifacts: readonly LongMemEvalEvidenceArtifactInput[]
): Promise<void> {
  await Promise.all(artifacts.map(async (artifact) => {
    if (artifact.contents === undefined) throw new Error("fixture bytes missing");
    const artifactPath = path.join(entryRoot, artifact.path);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, artifact.contents);
  }));
  await writeFile(
    path.join(entryRoot, LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function mutateFirstChild(
  artifacts: readonly LongMemEvalEvidenceArtifactInput[],
  mutate: (child: MutableChild) => void
): LongMemEvalEvidenceArtifactInput[] {
  const childIndex = artifacts.findIndex((artifact) =>
    artifact.role === "shard_run_provenance"
  );
  const childArtifact = artifacts[childIndex];
  if (childArtifact?.contents === undefined) {
    throw new Error("child fixture bytes are missing");
  }
  const child = JSON.parse(Buffer.from(childArtifact.contents).toString("utf8")) as MutableChild;
  mutate(child);
  const childContents = `${JSON.stringify(child, null, 2)}\n`;
  return artifacts.map((artifact, index) => {
    if (index === childIndex) {
      return { role: artifact.role, path: artifact.path, contents: childContents };
    }
    if (artifact.role !== "run_provenance") return artifact;
    if (artifact.contents === undefined) throw new Error("child fixture bytes are missing");
    const aggregate = JSON.parse(Buffer.from(artifact.contents).toString("utf8")) as {
      shards: Array<{ sha256: string }>;
    };
    aggregate.shards[0]!.sha256 = createHash("sha256")
      .update(childContents)
      .digest("hex");
    return {
      role: artifact.role,
      path: artifact.path,
      contents: `${JSON.stringify(aggregate, null, 2)}\n`
    };
  });
}
