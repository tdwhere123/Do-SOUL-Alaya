import { createHash } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionSourceHash,
  formatVerifiedUserAssertionV2SourceHash,
  type AssociativeFactFrame
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteSignalRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID } from
  "@do-soul/alaya-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  rebuildEvidenceSearchProjectionsOnWorkingCopy
} from "../../../bench/snapshot/recall-eval/evidence-search-projection-rebuild.js";
import {
  backfillMissingFactFrameFormations
} from "../../../bench/snapshot/recall-eval/fact-frame-formation/backfill.js";
import {
  cleanupProjectionRebuildFixtures,
  createSourceFixture,
  message,
  insertStaleProjection,
  readProjectionRows,
  type SeededOwner
} from "./evidence-search-projection-rebuild-fixture.js";

const ASSERTION = "I bought my bookshelf from IKEA.";
const ASSERTION_SHA256 = createHash("sha256").update(ASSERTION, "utf8").digest("hex");
const FRAME: AssociativeFactFrame = {
  schema_version: 1,
  slots: [
    { role: "subject", text: "I" },
    { role: "relation", text: "bought my bookshelf from" },
    { role: "value", text: "IKEA" }
  ]
};

afterEach(async () => {
  await cleanupProjectionRebuildFixtures();
});

describe("verified assertion fact-frame working-copy formation", () => {
  it("backfills missing captures through the production default normalizer", async () => {
    const fixture = await assertionFixture();
    const workingDbPath = join(fixture.root, "working-default.db");
    await copyFile(fixture.sourceDbPath, workingDbPath);
    insertStaleProjection(workingDbPath, fixture.evidenceIds[0]!);

    const first = await rebuildEvidenceSearchProjectionsOnWorkingCopy({
      workingDbPath,
      backfillMissingFactFrameFormations: true
    });
    const rows = readProjectionRows(workingDbPath);

    expect(first.fact_frame_formation_backfill).toMatchObject({
      schema_version: 1,
      operator_id: "default_evidence_fact_frame_formation_backfill_v1",
      eligible_owner_count: 1,
      existing_capture_count: 0,
      backfilled_capture_count: 1,
      formed_capture_count: 1,
      unavailable_capture_count: 0,
      rejected_capture_count: 0,
      projection_count: 4
    });
    expect(rows.filter((row) => row.projection_kind === "fact_key").map((row) => row.content))
      .toEqual([
        "I bought my bookshelf from IKEA",
        "bought my bookshelf from IKEA",
        "I my bookshelf from IKEA",
        "I bought"
      ]);
    expect(rows).toContainEqual(expect.objectContaining({
      projection_kind: "user_assertion",
      content: "stale projection"
    }));
    expect(readFormation(workingDbPath)).toMatchObject({
      status: "formed",
      producer_operator_id: RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID
    });

    const second = await rebuildEvidenceSearchProjectionsOnWorkingCopy({
      workingDbPath,
      backfillMissingFactFrameFormations: true
    });
    expect(second.fact_frame_formation_backfill).toMatchObject({
      eligible_owner_count: 1,
      existing_capture_count: 1,
      backfilled_capture_count: 0,
      projection_count: 0
    });
    expect(readProjectionRows(workingDbPath)).toEqual(rows);
  });

  it("keeps canonical receipts stable across authority batch boundaries", async () => {
    const fixture = await createSourceFixture([
      {
        signalId: "signal-assertion-a",
        evidenceId: "10000000-0000-4000-8000-000000000011",
        messages: [message("u1", "user", ASSERTION)]
      },
      {
        signalId: "signal-assertion-b",
        evidenceId: "10000000-0000-4000-8000-000000000012",
        messages: [message("u2", "user", ASSERTION)]
      }
    ]);
    const db = initDatabase({ filename: fixture.sourceDbPath, temporalMode: "candidate" });
    try {
      bindStoredAssertionOwner(db, "signal-assertion-a", fixture.evidenceIds[0]!);
      bindStoredAssertionOwner(db, "signal-assertion-b", fixture.evidenceIds[1]!, 2);
      const report = db.connection.transaction(() =>
        backfillMissingFactFrameFormations(db, 1)
      )();

      expect(report).toMatchObject({
        eligible_owner_count: 2,
        existing_capture_count: 0,
        backfilled_capture_count: 2,
        formed_capture_count: 2,
        projection_count: 8,
        capture_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        projection_content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });
    } finally {
      db.close();
    }
  });

  it("atomically binds a source-exact ledger and rebuilds fact-key projections", async () => {
    const fixture = await assertionFixture();
    const workingDbPath = join(fixture.root, "working.db");
    const ledgerPath = join(fixture.root, "fact-frames.ndjson");
    await copyFile(fixture.sourceDbPath, workingDbPath);
    await writeLedger(ledgerPath, ASSERTION_SHA256);

    const report = await rebuildEvidenceSearchProjectionsOnWorkingCopy({
      workingDbPath,
      factFrameRetrofitLedgerPath: ledgerPath
    });

    expect(report.fact_frame_retrofit).toMatchObject({
      schema_version: 1,
      ledger_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ledger_record_count: 1,
      rebuilt_owner_count: 1,
      projection_count: 4,
      projection_content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      formation_operator_id: "sealed_fact_frame_retrofit_ledger_v1",
      formation_capture_count: 1,
      formation_capture_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    const projectionRows = readProjectionRows(workingDbPath);
    expect(projectionRows.map((row) => row.content)).toEqual([
      "I bought my bookshelf from IKEA",
      "bought my bookshelf from IKEA",
      "I IKEA",
      "I bought my bookshelf from"
    ]);
    expect(report.fact_frame_retrofit?.projection_content_sha256).toBe(
      createHash("sha256").update(JSON.stringify(projectionRows), "utf8").digest("hex")
    );
    expect(readSignalPayload(workingDbPath, "signal-assertion").fact_frame).toBeUndefined();
    expect(readFormation(workingDbPath)).toMatchObject({
      status: "formed",
      producer_operator_id: "sealed_fact_frame_retrofit_ledger_v1",
      fact_frame: FRAME
    });
  });

  it("rolls back every retrofit mutation when assertion authority does not match", async () => {
    const fixture = await assertionFixture();
    const workingDbPath = join(fixture.root, "working-invalid.db");
    const ledgerPath = join(fixture.root, "invalid-fact-frames.ndjson");
    await copyFile(fixture.sourceDbPath, workingDbPath);
    await writeLedger(ledgerPath, "0".repeat(64));

    await expect(rebuildEvidenceSearchProjectionsOnWorkingCopy({
      workingDbPath,
      factFrameRetrofitLedgerPath: ledgerPath
    })).rejects.toThrow(/source_assertion_sha256 mismatch/u);

    expect(readSignalPayload(workingDbPath, "signal-assertion").fact_frame).toBeUndefined();
    expect(readProjectionRows(workingDbPath)).toEqual([]);
    expect(readFormation(workingDbPath)).toBeNull();
  });
});

async function assertionFixture(): ReturnType<typeof createSourceFixture> {
  return createSourceFixture([{
    signalId: "signal-assertion",
    evidenceId: "10000000-0000-4000-8000-000000000001",
    messages: [message("u1", "user", ASSERTION)]
  }], bindVerifiedAssertionOwner);
}

function bindVerifiedAssertionOwner(
  db: StorageDatabase,
  owner: SeededOwner,
  receiptVersion: 1 | 2 = 1
): void {
  const row = db.connection.prepare(
    "SELECT gist FROM evidence_capsules WHERE object_id = ?"
  ).get(owner.evidenceId) as { readonly gist: string };
  const baseReceipt = {
      workspace_id: owner.signal.workspace_id,
      run_id: owner.signal.run_id,
      surface_id: owner.signal.surface_id,
      source_assertion: ASSERTION,
      source_corpus: row.gist
  };
  const sourceLocator = {
    contract_version: 2 as const,
    kind: "assertion_catalog" as const,
    assertion_id: 1
  };
  const sourceHash = receiptVersion === 1
    ? formatVerifiedUserAssertionSourceHash(digest(
      buildVerifiedUserAssertionReceiptPreimage(baseReceipt)
    ))
    : formatVerifiedUserAssertionV2SourceHash(digest(
      buildVerifiedUserAssertionReceiptV2Preimage({
        ...baseReceipt,
        signal_id: owner.signal.signal_id,
        source_locator: sourceLocator
      })
    ));
  db.connection.prepare(
    "UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?"
  ).run(JSON.stringify({
    ...owner.signal.raw_payload,
    source_assertion: ASSERTION,
    distilled_fact: ASSERTION,
    verified_user_assertion_source_hash: sourceHash,
    ...(receiptVersion === 1 ? {} : { source_locator: sourceLocator }),
    source_grounding: {
      version: 1,
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: ASSERTION,
      proposed_matched_text: ASSERTION,
      reasons: []
    }
  }), owner.signal.signal_id);
  db.connection.prepare(`
    UPDATE evidence_capsules
       SET excerpt = ?, source_hash = ?, physical_anchor = ?
     WHERE object_id = ?
  `).run(ASSERTION, sourceHash, JSON.stringify({
    file_path: null,
    line_range: null,
    symbol_name: null,
    artifact_ref: "sealed-source-artifact-f0"
  }), owner.evidenceId);
}

function bindStoredAssertionOwner(
  db: StorageDatabase,
  signalId: string,
  evidenceId: string,
  receiptVersion: 1 | 2 = 1
): void {
  const signal = new SqliteSignalRepo(db).getByIdInCurrentTransaction(signalId);
  if (signal === null) throw new Error(`fixture signal ${signalId} missing`);
  bindVerifiedAssertionOwner(db, { signal, evidenceId }, receiptVersion);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeLedger(path: string, assertionSha256: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schema_version: 1,
    signal_id: "signal-assertion",
    source_assertion_sha256: assertionSha256,
    fact_frame: FRAME
  })}\n`, "utf8");
}

function readSignalPayload(path: string, signalId: string): Record<string, unknown> {
  const db = initDatabase({ filename: path, temporalMode: "candidate" });
  try {
    const row = db.connection.prepare(
      "SELECT raw_payload_json FROM signals WHERE signal_id = ?"
    ).get(signalId) as { readonly raw_payload_json: string };
    return JSON.parse(row.raw_payload_json) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function readFormation(path: string): Record<string, unknown> | null {
  const db = initDatabase({ filename: path, temporalMode: "candidate" });
  try {
    const row = db.connection.prepare(`
      SELECT status, producer_operator_id, fact_frame_json
      FROM evidence_fact_frame_formations
    `).get() as {
      readonly status: string;
      readonly producer_operator_id: string | null;
      readonly fact_frame_json: string | null;
    } | undefined;
    return row === undefined ? null : {
      status: row.status,
      producer_operator_id: row.producer_operator_id,
      fact_frame: row.fact_frame_json === null ? null : JSON.parse(row.fact_frame_json)
    };
  } finally {
    db.close();
  }
}
