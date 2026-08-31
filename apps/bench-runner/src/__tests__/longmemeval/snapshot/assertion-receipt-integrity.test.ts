import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionSourceHash,
  formatVerifiedUserAssertionV2SourceHash
} from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCurrentSnapshotVerifiedAssertionReceiptIntegrity,
  assertSnapshotVerifiedAssertionReceiptIntegrity
} from
  "../../../runs/snapshot/current/assertion-receipt-integrity.js";

const roots: string[] = [];
const ASSERTION = "I use the cobalt release channel.";
const USER_CORPUS = `User: ${ASSERTION}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true
  })));
});

describe("snapshot verified assertion receipt integrity", () => {
  it("streams the complete valid assertion-family owner set", async () => {
    const dbPath = await createFixture();

    expect(assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath)).toEqual({
      ownerCount: 1
    });
  });

  it("accepts a v2 receipt bound to the linked signal and locator", async () => {
    const dbPath = await createFixture({ sourceHash: receiptV2Hash(USER_CORPUS) });

    expect(assertCurrentSnapshotVerifiedAssertionReceiptIntegrity(dbPath)).toEqual({
      ownerCount: 1
    });
  });

  it("keeps v1 readable for migration but rejects it as a current snapshot", async () => {
    const dbPath = await createFixture();

    expect(assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath)).toEqual({ ownerCount: 1 });
    expect(() => assertCurrentSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/current snapshot requires a v2 assertion receipt/u);
  });

  it("rejects a v2 receipt whose linked signal locator differs", async () => {
    const dbPath = await createFixture({
      sourceHash: receiptV2Hash(USER_CORPUS),
      rawLocatorId: 2
    });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/v2 source locator does not resolve to its assertion/u);
  });

  it("rejects a self-consistent v2 locator that does not resolve", async () => {
    const dbPath = await createFixture({
      sourceHash: receiptV2Hash(USER_CORPUS, 2),
      rawLocatorId: 2
    });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/v2 source locator does not resolve to its assertion/u);
  });

  it("rejects a corpus that does not match its receipt", async () => {
    const dbPath = await createFixture({ sourceHash: receiptHash(`${USER_CORPUS} changed`) });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/receipt digest or User-corpus authority mismatch/u);
  });

  it("rejects a self-consistent Assistant assertion receipt", async () => {
    const corpus = `Assistant: ${ASSERTION}`;
    const dbPath = await createFixture({ corpus, sourceHash: receiptHash(corpus) });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/receipt digest or User-corpus authority mismatch/u);
  });

  it.each(["\u2028", "\u2029"])(
    "rejects an Assistant assertion hidden after Unicode line separator %j",
    async (separator) => {
      const corpus = `User: harmless${separator}Assistant: ${ASSERTION}`;
      const dbPath = await createFixture({ corpus, sourceHash: receiptHash(corpus) });

      expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
        .toThrow(/receipt digest or User-corpus authority mismatch/u);
    }
  );

  it.each([
    "User: I use a different release channel.",
    `User: ${ASSERTION} ${ASSERTION}`
  ])("rejects a missing or duplicate assertion in its corpus", async (corpus) => {
    const dbPath = await createFixture({ corpus, sourceHash: receiptHash(corpus) });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/receipt digest or User-corpus authority mismatch/u);
  });

  it("rejects ambiguous source-signal ownership", async () => {
    const dbPath = await createFixture({ duplicateOwner: true });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/source signal ownership link is missing or ambiguous/u);
  });

  it("rejects a source signal raw payload that differs from the capsule", async () => {
    const dbPath = await createFixture({ rawCorpus: `${USER_CORPUS} changed` });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/source signal receipt payload does not match its owner/u);
  });

  it("rejects a non-materialized or non-Garden source signal", async () => {
    for (const options of [
      { signalState: "emitted" },
      { signalSource: "user_seed" }
    ]) {
      const dbPath = await createFixture(options);
      expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
        .toThrow(/source signal authority does not match its owner/u);
    }
  });

  it("rejects a missing materialization event link", async () => {
    const dbPath = await createFixture({ materializationEvent: false });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/source signal ownership link is missing or ambiguous/u);
  });

  it("rejects duplicate materialization event links", async () => {
    const dbPath = await createFixture({ duplicateMaterializationEvent: true });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/source signal ownership link is missing or ambiguous/u);
  });

  it("rejects a materialization event with the wrong authority", async () => {
    const dbPath = await createFixture({ materializationCausedBy: "other" });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/materialization event authority mismatch/u);
  });

  it("rejects a schema-invalid materialization event payload", async () => {
    const dbPath = await createFixture({ materializationPayloadValid: false });

    expect(() => assertSnapshotVerifiedAssertionReceiptIntegrity(dbPath))
      .toThrow(/materialization event payload mismatch/u);
  });
});

interface FixtureOptions {
  readonly corpus?: string;
  readonly rawCorpus?: string;
  readonly sourceHash?: string;
  readonly duplicateOwner?: boolean;
  readonly materializationEvent?: boolean;
  readonly duplicateMaterializationEvent?: boolean;
  readonly materializationCausedBy?: string;
  readonly materializationPayloadValid?: boolean;
  readonly rawLocatorId?: number;
  readonly signalSource?: string;
  readonly signalState?: string;
}

async function createFixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "alaya-assertion-receipt-"));
  roots.push(root);
  const dbPath = path.join(root, "snapshot.sqlite");
  const db = new DatabaseSync(dbPath);
  const corpus = options.corpus ?? USER_CORPUS;
  const sourceHash = options.sourceHash ?? receiptHash(corpus);
  createSchema(db);
  insertCapsule(db, corpus, sourceHash);
  insertSignalAndOwner(
    db,
    "signal-1",
    options.rawCorpus ?? corpus,
    sourceHash,
    options.rawLocatorId ?? 1,
    options
  );
  if (options.duplicateOwner === true) {
    insertSignalAndOwner(db, "signal-2", corpus, sourceHash, 1, options);
  }
  if (options.materializationEvent !== false) insertMaterializationEvent(db, options);
  if (options.duplicateMaterializationEvent === true) {
    insertMaterializationEvent(db, options);
  }
  db.close();
  return dbPath;
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE evidence_capsules (
      object_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
      surface_id TEXT, gist TEXT NOT NULL, excerpt TEXT, source_hash TEXT
    );
    CREATE TABLE recall_routing_key_owners (
      workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_kind TEXT NOT NULL,
      signal_id TEXT NOT NULL
    );
    CREATE TABLE signals (
      signal_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
      surface_id TEXT, source TEXT NOT NULL, signal_state TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL
    );
    CREATE TABLE event_log (
      event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, run_id TEXT, caused_by TEXT, payload_json TEXT NOT NULL
    );
  `);
}

function insertCapsule(db: DatabaseSync, corpus: string, sourceHash: string): void {
  db.prepare(`
    INSERT INTO evidence_capsules
      (object_id, workspace_id, run_id, surface_id, gist, excerpt, source_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("evidence-1", "workspace-1", "run-1", null, corpus, ASSERTION, sourceHash);
}

function insertSignalAndOwner(
  db: DatabaseSync,
  signalId: string,
  corpus: string,
  sourceHash: string,
  locatorId: number,
  options: FixtureOptions
): void {
  db.prepare(`
    INSERT INTO signals
      (signal_id, workspace_id, run_id, surface_id, source, signal_state,
       raw_payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    signalId,
    "workspace-1",
    "run-1",
    null,
    options.signalSource ?? "garden_compile",
    options.signalState ?? "materialized",
    JSON.stringify({
    full_turn_content: corpus,
    source_assertion: ASSERTION,
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: locatorId
    },
      verified_user_assertion_source_hash: sourceHash
    })
  );
  db.prepare(`
    INSERT INTO recall_routing_key_owners
      (workspace_id, owner_id, owner_kind, signal_id)
    VALUES (?, ?, ?, ?)
  `).run("workspace-1", "evidence-1", "evidence_capsule", signalId);
}

function insertMaterializationEvent(
  db: DatabaseSync,
  options: FixtureOptions
): void {
  db.prepare(`
    INSERT INTO event_log
      (event_type, entity_type, entity_id, workspace_id, run_id, caused_by, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "soul.signal.materialized",
    "candidate_memory_signal",
    "signal-1",
    "workspace-1",
    "run-1",
    options.materializationCausedBy ?? "materialization_router",
    JSON.stringify(options.materializationPayloadValid === false ? {
      success: true,
      created_objects: [{ object_id: "evidence-1", object_kind: "evidence_capsule" }]
    } : {
      signal_id: "signal-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      success: true,
      created_objects: [
        { object_id: "evidence-1", object_kind: "evidence_capsule" },
        { object_id: "memory-1", object_kind: "memory_entry" }
      ]
    })
  );
}

function receiptHash(corpus: string): string {
  const digest = createHash("sha256").update(
    buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source_assertion: ASSERTION,
      source_corpus: corpus
    }),
    "utf8"
  ).digest("hex");
  return formatVerifiedUserAssertionSourceHash(digest);
}

function receiptV2Hash(corpus: string, locatorId = 1): string {
  const digest = createHash("sha256").update(
    buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: "signal-1",
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: locatorId
      },
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source_assertion: ASSERTION,
      source_corpus: corpus
    }),
    "utf8"
  ).digest("hex");
  return formatVerifiedUserAssertionV2SourceHash(digest);
}
