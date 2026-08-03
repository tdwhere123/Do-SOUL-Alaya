import { createHash } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash,
  type AssociativeFactFrame
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  rebuildEvidenceSearchProjectionsOnWorkingCopy
} from "../../../longmemeval/snapshot/recall-eval/evidence-search-projection-rebuild.js";
import {
  cleanupProjectionRebuildFixtures,
  createSourceFixture,
  message,
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

describe("verified assertion fact-frame retrofit", () => {
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
      projection_content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
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
    expect(readSignalPayload(workingDbPath, "signal-assertion").fact_frame).toEqual(FRAME);
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
  });
});

async function assertionFixture(): ReturnType<typeof createSourceFixture> {
  return createSourceFixture([{
    signalId: "signal-assertion",
    evidenceId: "10000000-0000-4000-8000-000000000001",
    messages: [message("u1", "user", ASSERTION)]
  }], bindVerifiedAssertionOwner);
}

function bindVerifiedAssertionOwner(db: StorageDatabase, owner: SeededOwner): void {
  const row = db.connection.prepare(
    "SELECT gist FROM evidence_capsules WHERE object_id = ?"
  ).get(owner.evidenceId) as { readonly gist: string };
  const sourceHash = formatVerifiedUserAssertionSourceHash(createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: owner.signal.workspace_id,
      run_id: owner.signal.run_id,
      surface_id: owner.signal.surface_id,
      source_assertion: ASSERTION,
      source_corpus: row.gist
    }), "utf8")
    .digest("hex"));
  db.connection.prepare(
    "UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?"
  ).run(JSON.stringify({
    ...owner.signal.raw_payload,
    source_assertion: ASSERTION,
    distilled_fact: ASSERTION,
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
