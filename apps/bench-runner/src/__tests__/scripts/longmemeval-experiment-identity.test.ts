import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExperimentPairIdentity,
  readExperimentSnapshotIdentity
} from "../../../scripts/longmemeval-experiment-identity.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("LongMemEval experiment identity", () => {
  it("records frozen artifact and dataset hashes without duplicating loader validation", async () => {
    const fixture = await snapshotFixture();

    await expect(readExperimentSnapshotIdentity(
      fixture.snapshotPath,
      fixture.datasetPath
    )).resolves.toMatchObject({
      snapshot: {
        db_sha256: sha256(fixture.db),
        manifest_sha256: sha256(fixture.manifest),
        sidecar_sha256: sha256(fixture.sidecar),
        extraction_authority_sha256: sha256(fixture.authority)
      },
      dataset: { sha256: sha256(fixture.dataset) }
    });
  });

  it("proves A/B differ only by the embedding treatment on one snapshot", () => {
    const cellA = cellIdentity("A", "disabled");
    const cellB = cellIdentity("B", "env");

    expect(buildExperimentPairIdentity(cellA, cellB)).toMatchObject({
      kind: "longmemeval_experiment_pair_identity",
      snapshot: cellA.snapshot,
      runner: cellA.runner,
      cells: {
        A: { embedding_mode: "disabled", cross_encoder_enabled: false },
        B: { embedding_mode: "env", cross_encoder_enabled: false }
      }
    });
  });

  it.each([
    ["snapshot", { snapshot: { ...cellIdentity("B", "env").snapshot, db_sha256: "9".repeat(64) } }],
    ["runner", { runner: { ...cellIdentity("B", "env").runner, worktree_state_sha256: "8".repeat(64) } }],
    ["treatment", { treatment: { ...cellIdentity("B", "env").treatment, cross_encoder_enabled: true } }]
  ])("rejects %s drift between experiment cells", (_label, drift) => {
    expect(() => buildExperimentPairIdentity(
      cellIdentity("A", "disabled"),
      { ...cellIdentity("B", "env"), ...drift }
    )).toThrow(/experiment A\/B identity/u);
  });
});

async function snapshotFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "longmemeval-experiment-"));
  roots.push(root);
  const snapshotPath = path.join(root, "snapshot", "source.db");
  const datasetPath = path.join(root, "dataset", "longmemeval_s.json");
  await Promise.all([
    mkdir(path.dirname(snapshotPath), { recursive: true }),
    mkdir(path.dirname(datasetPath), { recursive: true })
  ]);
  const db = Buffer.from("db");
  const sidecar = Buffer.from("{}\n");
  const authority = Buffer.from("{}\n");
  const dataset = Buffer.from("[]\n");
  const manifest = Buffer.from('{"loader":"owns-validation"}\n');
  await Promise.all([
    writeFile(snapshotPath, db),
    writeFile(`${snapshotPath}.sidecar.json`, sidecar),
    writeFile(`${snapshotPath}.extraction-authority.json`, authority),
    writeFile(`${snapshotPath}.manifest.json`, manifest),
    writeFile(datasetPath, dataset)
  ]);
  return { snapshotPath, datasetPath, db, manifest, sidecar, authority, dataset };
}

function cellIdentity(cell: "A" | "B", embeddingMode: "disabled" | "env") {
  return {
    schema_version: 2,
    kind: "longmemeval_matrix_cell_runner_identity",
    mode: "experiment",
    cell,
    run_root: "/run",
    snapshot: {
      db_sha256: "1".repeat(64),
      manifest_sha256: "2".repeat(64),
      sidecar_sha256: "3".repeat(64),
      extraction_authority_sha256: "4".repeat(64)
    },
    dataset: {
      sha256: "6".repeat(64)
    },
    runner: {
      commit_sha: "8".repeat(40),
      commit_sha7: "8".repeat(7),
      worktree_clean: false,
      worktree_state_sha256: "9".repeat(64),
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "a".repeat(64),
        file_count: 10
      }
    },
    treatment: {
      extraction_model: "DeepSeek-V4-Flash",
      embedding_mode: embeddingMode,
      cross_encoder_enabled: false
    },
    weight_overrides: null
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
