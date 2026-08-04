import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindExperimentCellRebuildIdentity,
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
    const report = rebuildReport(factFrameRetrofitReport());
    const cellA = withFactFrameLedger(
      rebuiltCellIdentity("A", "disabled", report)
    );
    const cellB = withFactFrameLedger(
      rebuiltCellIdentity("B", "env", report)
    );

    expect(buildExperimentPairIdentity(cellA, cellB)).toMatchObject({
      kind: "longmemeval_experiment_pair_identity",
      snapshot: cellA.snapshot,
      runner: cellA.runner,
      evaluation_slice: { offset: 100, limit: 100 },
      derived_snapshot_identity: report,
      cells: {
        A: {
          embedding_mode: "disabled",
          cross_encoder_enabled: false,
          fact_frame_retrofit_ledger_sha256: "f".repeat(64)
        },
        B: {
          embedding_mode: "env",
          cross_encoder_enabled: false,
          fact_frame_retrofit_ledger_sha256: "f".repeat(64)
        }
      }
    });
  });

  it.each([
    ["snapshot", { snapshot: { ...cellIdentity("B", "env").snapshot, db_sha256: "9".repeat(64) } }],
    ["runner", { runner: { ...cellIdentity("B", "env").runner, worktree_state_sha256: "8".repeat(64) } }],
    ["slice", { evaluation_slice: { offset: 200, limit: 100 } }],
    ["treatment", { treatment: { ...cellIdentity("B", "env").treatment, cross_encoder_enabled: true } }],
    ["rebuild", {
      treatment: {
        ...cellIdentity("B", "env").treatment,
        derived_evidence_projection_rebuild: true
      }
    }]
  ])("rejects %s drift between experiment cells", (_label, drift) => {
    expect(() => buildExperimentPairIdentity(
      cellIdentity("A", "disabled"),
      { ...cellIdentity("B", "env"), ...drift }
    )).toThrow(/experiment A\/B identity/u);
  });

  it("binds a derived projection report from the rank artifact into cell identity", () => {
    const cell = {
      ...cellIdentity("A", "disabled"),
      treatment: {
        ...cellIdentity("A", "disabled").treatment,
        derived_evidence_projection_rebuild: true
      }
    };
    const report = rebuildReport();

    expect(bindExperimentCellRebuildIdentity(cell, {
      schema_version: 2,
      snapshot_binding: {
        expected_question_count: 100,
        expected_question_id_digest: "b".repeat(64),
        derived_evidence_projection_rebuild: report
      }
    })).toMatchObject({
      derived_snapshot_identity: report
    });
  });

  it("rejects A/B cells with different rebuilt database identities", () => {
    const cellA = rebuiltCellIdentity("A", "disabled", rebuildReport());
    const cellB = rebuiltCellIdentity("B", "env", {
      ...rebuildReport(),
      rebuilt_db_identity_sha256: "f".repeat(64)
    });

    expect(() => buildExperimentPairIdentity(cellA, cellB))
      .toThrow(/experiment A\/B identity/u);
  });

  it("rejects A/B cells with different Fact Frame ledger treatments", () => {
    const cellA = withFactFrameLedger(
      rebuiltCellIdentity(
        "A",
        "disabled",
        rebuildReport(factFrameRetrofitReport())
      )
    );
    const cellB = withFactFrameLedger(
      rebuiltCellIdentity(
        "B",
        "env",
        rebuildReport(factFrameRetrofitReport("a".repeat(64)))
      ),
      "a".repeat(64)
    );

    expect(() => buildExperimentPairIdentity(cellA, cellB))
      .toThrow(/experiment A\/B identity/u);
  });

  it("rejects a rebuild identity not derived from the frozen cell snapshot", () => {
    const cell = {
      ...cellIdentity("A", "disabled"),
      treatment: {
        ...cellIdentity("A", "disabled").treatment,
        derived_evidence_projection_rebuild: true
      }
    };

    expect(() => bindExperimentCellRebuildIdentity(cell, {
      snapshot_binding: {
        derived_evidence_projection_rebuild: {
          ...rebuildReport(),
          input_db_sha256: "0".repeat(64)
        }
      }
    })).toThrow(/rebuild input differs/u);
  });

  it("rejects a Fact Frame treatment that differs from the applied ledger", () => {
    const identity = cellIdentity("A", "disabled");
    const cell = withFactFrameLedger({
      ...identity,
      treatment: {
        ...identity.treatment,
        derived_evidence_projection_rebuild: true
      }
    });

    expect(() => bindExperimentCellRebuildIdentity(cell, {
      snapshot_binding: {
        derived_evidence_projection_rebuild: rebuildReport(
          factFrameRetrofitReport("a".repeat(64))
        )
      }
    })).toThrow(/Fact Frame retrofit ledger differs/u);
  });

  it("rejects a Fact Frame report without a matching treatment", () => {
    const identity = cellIdentity("A", "disabled");
    const cell = {
      ...identity,
      treatment: {
        ...identity.treatment,
        derived_evidence_projection_rebuild: true
      }
    };

    expect(() => bindExperimentCellRebuildIdentity(cell, {
      snapshot_binding: {
        derived_evidence_projection_rebuild: rebuildReport(
          factFrameRetrofitReport()
        )
      }
    })).toThrow(/Fact Frame retrofit ledger differs/u);
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
      cross_encoder_enabled: false,
      derived_evidence_projection_rebuild: false
    },
    derived_snapshot_identity: null,
    weight_overrides: null,
    evaluation_slice: {
      offset: 100,
      limit: 100
    }
  };
}

function rebuiltCellIdentity(
  cell: "A" | "B",
  embeddingMode: "disabled" | "env",
  report: ReturnType<typeof rebuildReport>
) {
  const identity = cellIdentity(cell, embeddingMode);
  return {
    ...identity,
    treatment: {
      ...identity.treatment,
      derived_evidence_projection_rebuild: true
    },
    derived_snapshot_identity: report
  };
}

function withFactFrameLedger<T extends { treatment: object }>(
  identity: T,
  ledgerSha = "f".repeat(64)
) {
  return {
    ...identity,
    treatment: {
      ...identity.treatment,
      fact_frame_retrofit_ledger_sha256: ledgerSha
    }
  };
}

function rebuildReport(factFrameRetrofit?: ReturnType<typeof factFrameRetrofitReport>) {
  const report = {
    schema_version: 1,
    promotable: false,
    input_db_sha256: "1".repeat(64),
    rebuilt_db_identity_sha256: "d".repeat(64),
    source_schema_version: 108,
    working_schema_version: 110,
    eligible_owner_count: 10,
    rebuilt_owner_count: 10,
    rejected_owner_count: 0,
    zero_child_owner_count: 2,
    nonzero_child_owner_count: 8,
    child_count: 12,
    projection_kind_counts: [
      { projection_kind: "assistant_observation", child_count: 4 },
      { projection_kind: "user_assertion", child_count: 8 }
    ],
    projection_content_sha256: "e".repeat(64)
  };
  return factFrameRetrofit === undefined
    ? report
    : { ...report, fact_frame_retrofit: factFrameRetrofit };
}

function factFrameRetrofitReport(ledgerSha = "f".repeat(64)) {
  return {
    schema_version: 1,
    ledger_sha256: ledgerSha,
    ledger_record_count: 66,
    rebuilt_owner_count: 66,
    rejected_record_count: 0,
    projection_count: 318,
    projection_content_sha256: "c".repeat(64)
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
