import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { materializeEvidenceFactFrameFormation } from "@do-soul/alaya-core";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFactFrameFormationAuditCommand } from
  "../../../cli/fact-frame-formation-audit/command.js";
import { auditEvidenceFactFrameFormations } from
  "../../../longmemeval/snapshot/recall-eval/fact-frame-formation/audit.js";
import { summarizeFactFrameFormationBindings } from
  "../../../longmemeval/snapshot/recall-eval/fact-frame-formation-summary.js";

const roots: string[] = [];
const FORMED_ID = "00000000-0000-4000-8000-000000000001";
const UNAVAILABLE_ID = "00000000-0000-4000-8000-000000000002";
const LEGACY_ID = "00000000-0000-4000-8000-000000000003";
const REJECTED_ID = "00000000-0000-4000-8000-000000000004";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("fact-frame formation audit", () => {
  it("replays every capture and proves exact persisted FactKey bindings", async () => {
    const dbPath = await createAuditFixture();

    const report = await auditEvidenceFactFrameFormations(dbPath);

    expect(report).toMatchObject({
      schema_version: 1,
      report_kind: "evidence_fact_frame_formation_audit",
      promotable: false,
      working_schema_version: 118,
      integrity_valid: true,
      formation_complete: true,
      evidence_owner_count: 3,
      source_eligible_owner_count: 3,
      capture_count: 3,
      captured_source_eligible_owner_count: 3,
      legacy_uncaptured_owner_count: 0,
      source_bound_count: 3,
      formed_owner_count: 1,
      formed_rate_of_source_eligible: 1 / 3,
      fact_key_projection_count: 4,
      replay_verified_owner_count: 3,
      invalid_owner_count: 0,
      invalid_reason_counts: []
    });
    expect(report.status_counts).toEqual([
      { status: "formed", capture_count: 1 },
      { status: "rejected", capture_count: 1 },
      { status: "unavailable", capture_count: 1 }
    ]);
    expect(report.producer_operator_counts).toEqual([
      { producer_operator_id: null, capture_count: 1 },
      { producer_operator_id: "audit_fixture_v1", capture_count: 1 },
      { producer_operator_id: "audit_rejected_fixture_v1", capture_count: 1 }
    ]);
    expect(report.snapshot_db_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.capture_binding_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.projection_binding_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reports legacy coverage debt without calling intact history corrupt", async () => {
    const dbPath = await createAuditFixture({ includeLegacyOwner: true });

    const report = await auditEvidenceFactFrameFormations(dbPath);

    expect(report.integrity_valid).toBe(true);
    expect(report.formation_complete).toBe(false);
    expect(report.legacy_uncaptured_owner_count).toBe(1);
    expect(report.invalid_owner_count).toBe(0);
  });

  it("fails integrity when persisted FactKeys diverge from Core replay", async () => {
    const dbPath = await createAuditFixture();
    const database = new DatabaseSync(dbPath);
    database.prepare(`
      UPDATE evidence_search_projections
      SET content = content || ' tampered'
      WHERE evidence_object_id = ?
        AND projection_kind = 'fact_key'
        AND projection_id = 1
    `).run(FORMED_ID);
    database.close();

    const report = await auditEvidenceFactFrameFormations(dbPath);

    expect(report.integrity_valid).toBe(false);
    expect(report.invalid_owner_count).toBe(1);
    expect(report.replay_verified_owner_count).toBe(2);
    expect(report.invalid_reason_counts).toEqual([
      { reason: "projection_mismatch", owner_count: 1 }
    ]);
  });

  it("rejects a snapshot with uncheckpointed WAL data", async () => {
    const dbPath = await createAuditFixture();
    await writeFile(`${dbPath}-wal`, "uncheckpointed", "utf8");

    await expect(auditEvidenceFactFrameFormations(dbPath)).rejects.toThrow(
      /uncheckpointed -wal data/u
    );
  });

  it("keeps the capture digest bound to the public summary fields", () => {
    const binding = {
      evidence_object_id: FORMED_ID,
      status: "formed",
      producer_operator_id: "audit_fixture_v1",
      source_hash: "source-hash",
      capture_digest: `sha256:${"a".repeat(64)}`
    };

    expect(summarizeFactFrameFormationBindings([{
      ...binding,
      workspace_id: "ignored-extension"
    }]).capture_binding_sha256).toBe(
      summarizeFactFrameFormationBindings([binding]).capture_binding_sha256
    );
  });

  it("publishes an invalid report once and returns the integrity exit code", async () => {
    const dbPath = await createAuditFixture();
    const database = new DatabaseSync(dbPath);
    database.prepare(`
      UPDATE evidence_search_projections SET content = content || ' tampered'
      WHERE evidence_object_id = ? AND projection_kind = 'fact_key'
    `).run(FORMED_ID);
    database.close();
    const outputPath = join(roots.at(-1)!, "formation-audit.json");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runFactFrameFormationAuditCommand([
        "--snapshot", dbPath, "--output", outputPath
      ])).toBe(1);
      const firstOutput = await readFile(outputPath, "utf8");
      expect(JSON.parse(firstOutput)).toMatchObject({
        integrity_valid: false,
        invalid_owner_count: 1
      });

      expect(await runFactFrameFormationAuditCommand([
        "--snapshot", dbPath, "--output", outputPath
      ])).toBe(2);
      expect(await readFile(outputPath, "utf8")).toBe(firstOutput);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

async function createAuditFixture(
  options: Readonly<{ readonly includeLegacyOwner?: boolean }> = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fact-frame-formation-audit-"));
  roots.push(root);
  const dbPath = join(root, "snapshot.db");
  const database = initDatabase({ filename: dbPath });
  await seedRuntime(database);
  const repo = new SqliteEvidenceCapsuleRepo(database);
  await createFormedEvidence(repo);
  await createUnavailableEvidence(repo);
  await createRejectedEvidence(repo);
  if (options.includeLegacyOwner === true) {
    await repo.create(evidenceCapsule(LEGACY_ID, "Legacy assertion."));
  }
  database.close();
  return dbPath;
}

async function seedRuntime(
  database: ReturnType<typeof initDatabase>
): Promise<void> {
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-audit",
    name: "formation audit",
    root_path: "/tmp/formation-audit",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-audit",
    workspace_id: "workspace-audit",
    title: "formation audit",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

async function createFormedEvidence(repo: SqliteEvidenceCapsuleRepo): Promise<void> {
  const assertion = "I use Atlas for research.";
  const capsule = evidenceCapsule(FORMED_ID, assertion);
  const formation = materializeEvidenceFactFrameFormation({
    sourceAssertion: assertion,
    sourceHash: capsule.source_hash,
    proposal: {
      schema_version: 1,
      producer_operator_id: "audit_fixture_v1",
      source_assertion: assertion,
      fact_frame: {
        schema_version: 1,
        slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "use" },
          { role: "value", text: "Atlas" }
        ]
      }
    }
  });
  await repo.create(capsule, formation.searchProjections, formation.capture);
}

async function createUnavailableEvidence(repo: SqliteEvidenceCapsuleRepo): Promise<void> {
  const capsule = evidenceCapsule(
    UNAVAILABLE_ID,
    "The deployment target is production."
  );
  const formation = materializeEvidenceFactFrameFormation({
    sourceAssertion: capsule.excerpt,
    sourceHash: capsule.source_hash,
    normalizer: null
  });
  await repo.create(capsule, formation.searchProjections, formation.capture);
}

async function createRejectedEvidence(repo: SqliteEvidenceCapsuleRepo): Promise<void> {
  const assertion = "I use Atlas for research.";
  const capsule = evidenceCapsule(REJECTED_ID, assertion);
  const formation = materializeEvidenceFactFrameFormation({
    sourceAssertion: assertion,
    sourceHash: capsule.source_hash,
    proposal: {
      schema_version: 1,
      producer_operator_id: "audit_rejected_fixture_v1",
      source_assertion: assertion,
      fact_frame: {
        schema_version: 1,
        slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "use" },
          { role: "value", text: "Nova" }
        ]
      }
    }
  });
  await repo.create(capsule, formation.searchProjections, formation.capture);
}

function evidenceCapsule(objectId: string, assertion: string): EvidenceCapsule {
  return {
    object_id: objectId,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-08-05T00:00:00.000Z",
    updated_at: "2026-08-05T00:00:00.000Z",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: {
      topic: "audit fixture",
      keywords: ["audit"],
      summary: assertion
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: assertion,
    excerpt: assertion,
    source_hash: `sha256:${objectId}`,
    run_id: "run-audit",
    workspace_id: "workspace-audit",
    surface_id: null
  };
}
