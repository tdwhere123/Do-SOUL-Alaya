import fs from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeCachedDatabase,
  initDatabase,
  inspectTemporalProjectionSelection,
  prepareTemporalCandidate,
  selectTemporalProjection
} from "@do-soul/alaya-storage";
import {
  cutOverTemporalProjection,
  recoverTemporalProjectionCutover,
  rollbackTemporalProjectionCutover
} from "../../runtime/temporal-cutover/cutover.js";
import {
  createTemporalCutoverJournal,
  readTemporalCutoverJournal
} from "../../runtime/temporal-cutover/journal.js";
import {
  acquireTemporalRuntimeLease,
  withTemporalCutoverLease
} from "../../runtime/temporal-cutover/lease.js";
import { replaceStorageDbPathInToml } from "../../runtime/config/storage-pointer-file.js";

interface Fixture {
  readonly directory: string;
  readonly sourceFilename: string;
  readonly candidateFilename: string;
  readonly receiptFilename: string;
  readonly tomlFilename: string;
  readonly journalFilename: string;
  readonly originalToml: string;
}

const FIXED_NOW = "2026-07-17T00:00:00.000Z";
type LeaseChild = ChildProcessByStdio<null, Readable, Readable>;

describe("temporal projection daemon cutover", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = createFixture();
    seedLegacySource(fixture.sourceFilename);
    await prepareTemporalCandidate({
      sourceFilename: fixture.sourceFilename,
      candidateFilename: fixture.candidateFilename,
      receiptFilename: fixture.receiptFilename
    });
    fs.writeFileSync(fixture.tomlFilename, fixture.originalToml, "utf8");
  });

  afterEach(() => {
    closeCachedDatabase(fixture.sourceFilename);
    closeCachedDatabase(fixture.candidateFilename);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });

  it("journals a pointer-first cutover, selects the candidate, and verifies ordinary bootstrap", async () => {
    const result = await cutOverTemporalProjection(cutoverInput(fixture));

    expect(result).toMatchObject({
      status: "committed",
      candidateFilename: fixture.candidateFilename,
      selectionId: expect.any(String)
    });
    expect(readPointer(fixture.tomlFilename)).toBe(fixture.candidateFilename);
    expect(await readTemporalCutoverJournal(fixture.journalFilename)).toMatchObject({
      status: "committed",
      originalToml: fixture.originalToml,
      originalPointer: fixture.sourceFilename,
      candidatePointer: fixture.candidateFilename,
      selectionId: result.selectionId
    });

    const runtime = initDatabase({ filename: fixture.candidateFilename });
    try {
      expect(inspectTemporalProjectionSelection(runtime)).toMatchObject({
        selected: true,
        selectionId: result.selectionId
      });
    } finally {
      runtime.close();
    }
  });

  it("restores the exact config pointer before clearing selection and does not promise legacy startup", async () => {
    await cutOverTemporalProjection(cutoverInput(fixture));
    const result = await rollbackTemporalProjectionCutover({
      journalFilename: fixture.journalFilename,
      reason: "fixture rollback",
      now: () => FIXED_NOW
    });

    expect(result).toMatchObject({
      status: "rolled_back",
      originalPointer: fixture.sourceFilename,
      originalRuntimeState: "not_verified_may_fail_closed"
    });
    expect(fs.readFileSync(fixture.tomlFilename, "utf8")).toBe(fixture.originalToml);
    const candidate = initDatabase({ filename: fixture.candidateFilename, temporalMode: "candidate" });
    try {
      expect(inspectTemporalProjectionSelection(candidate).selected).toBe(false);
    } finally {
      candidate.close();
    }
    expect(() => initDatabase({ filename: fixture.sourceFilename })).toThrow(/offline candidate cutover/i);
  });

  it("recovers a crash after candidate selection by restoring the pointer before selection rollback", async () => {
    const { candidateToml, selectionId } = await createPreparedJournal(fixture);
    fs.writeFileSync(fixture.tomlFilename, candidateToml, "utf8");
    selectFixtureCandidate(fixture, selectionId);

    const recovered = await recoverTemporalProjectionCutover({
      journalFilename: fixture.journalFilename,
      reason: "fixture recovery",
      now: () => FIXED_NOW
    });

    expect(recovered.status).toBe("compensated");
    expect(fs.readFileSync(fixture.tomlFilename, "utf8")).toBe(fixture.originalToml);
    const candidate = initDatabase({ filename: fixture.candidateFilename, temporalMode: "candidate" });
    try {
      expect(inspectTemporalProjectionSelection(candidate)).toMatchObject({ selected: false });
    } finally {
      candidate.close();
    }
    expect(await readTemporalCutoverJournal(fixture.journalFilename)).toMatchObject({
      status: "compensated"
    });
  });

  it("does not roll back a selection owned by another cutover journal", async () => {
    const { candidateToml } = await createPreparedJournal(fixture);
    const otherSelectionId = randomUUID();
    fs.writeFileSync(fixture.tomlFilename, candidateToml, "utf8");
    selectFixtureCandidate(fixture, otherSelectionId);

    await expect(recoverTemporalProjectionCutover({
      journalFilename: fixture.journalFilename,
      reason: "fixture recovery",
      now: () => FIXED_NOW
    })).rejects.toThrow(/different cutover journal/i);

    expect(fs.readFileSync(fixture.tomlFilename, "utf8")).toBe(fixture.originalToml);
    const candidate = initDatabase({ filename: fixture.candidateFilename, temporalMode: "candidate" });
    try {
      expect(inspectTemporalProjectionSelection(candidate)).toMatchObject({
        selected: true,
        selectionId: otherSelectionId
      });
    } finally {
      candidate.close();
    }
  });

  it("recovers a crash after rollback restored the pointer but before its journal transition", async () => {
    await cutOverTemporalProjection(cutoverInput(fixture));
    fs.writeFileSync(fixture.tomlFilename, fixture.originalToml, "utf8");

    const recovered = await recoverTemporalProjectionCutover({
      journalFilename: fixture.journalFilename,
      reason: "fixture rollback recovery",
      now: () => FIXED_NOW
    });

    expect(recovered.status).toBe("rolled_back");
    expect(fs.readFileSync(fixture.tomlFilename, "utf8")).toBe(fixture.originalToml);
    const candidate = initDatabase({ filename: fixture.candidateFilename, temporalMode: "candidate" });
    try {
      expect(inspectTemporalProjectionSelection(candidate).selected).toBe(false);
    } finally {
      candidate.close();
    }
    expect(await readTemporalCutoverJournal(fixture.journalFilename)).toMatchObject({
      status: "rolled_back"
    });
  });

  it("refuses a candidate receipt whose source is not the effective explicit config pointer", async () => {
    const unrelatedFilename = path.join(fixture.directory, "unrelated.db");
    fs.writeFileSync(
      fixture.tomlFilename,
      replaceStorageDbPathInToml(fixture.originalToml, unrelatedFilename),
      "utf8"
    );

    await expect(cutOverTemporalProjection(cutoverInput(fixture))).rejects.toThrow(
      /does not bind the configured original pointer/i
    );
    expect(readPointer(fixture.tomlFilename)).toBe(unrelatedFilename);
    expect(fs.existsSync(fixture.journalFilename)).toBe(false);
  });

  it("rejects a competing cutover while the config and candidate lease is held", async () => {
    await withTemporalCutoverLease(
      { configFilename: fixture.tomlFilename, candidateFilename: fixture.candidateFilename },
      async () => {
        await expect(cutOverTemporalProjection(cutoverInput(fixture))).rejects.toThrow(
          /already in progress/i
        );
      }
    );

    expect(fs.readFileSync(fixture.tomlFilename, "utf8")).toBe(fixture.originalToml);
    expect(fs.existsSync(fixture.journalFilename)).toBe(false);
  });

  it("requires the daemon to stop, then permits a restart-safe cutover after its runtime lease releases", async () => {
    const runtimeLease = await acquireTemporalRuntimeLease(fixture.sourceFilename);
    try {
      await expect(cutOverTemporalProjection(cutoverInput(fixture))).rejects.toThrow(
        /daemon must be stopped/i
      );
    } finally {
      await runtimeLease.release();
    }

    await expect(cutOverTemporalProjection(cutoverInput(fixture))).resolves.toMatchObject({
      status: "committed",
      candidateFilename: fixture.candidateFilename
    });
  });

  it("reclaims the runtime barrier after a crashed holder exits without deleting a lock file", async () => {
    const child = await holdRuntimeLockInChild(fixture.sourceFilename);
    try {
      await expect(acquireTemporalRuntimeLease(fixture.sourceFilename)).rejects.toThrow(
        /daemon must be stopped/i
      );

      child.kill();
      await once(child, "exit");

      const restartedLease = await acquireTemporalRuntimeLease(fixture.sourceFilename);
      await restartedLease.release();
      expect(fs.existsSync(`${fixture.sourceFilename}.temporal-runtime.lock.sqlite`)).toBe(true);
    } finally {
      if (!child.killed) child.kill();
    }
  });
});

function createFixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-temporal-cutover-"));
  const sourceFilename = path.join(directory, "legacy.db");
  return {
    directory,
    sourceFilename,
    candidateFilename: path.join(directory, "candidate.db"),
    receiptFilename: path.join(directory, "candidate-receipt.json"),
    tomlFilename: path.join(directory, "alaya.toml"),
    journalFilename: path.join(directory, "temporal-cutover-journal.json"),
    originalToml: [
      "# Preserve unrelated configuration exactly.",
      "[storage]",
      `db_path = ${JSON.stringify(sourceFilename)}`,
      "",
      "[runtime]",
      "mode = \"fixture\"",
      ""
    ].join("\n")
  };
}

function cutoverInput(fixture: Fixture) {
  return {
    configPaths: { tomlPath: fixture.tomlFilename },
    candidateFilename: fixture.candidateFilename,
    candidateReceiptFilename: fixture.receiptFilename,
    journalFilename: fixture.journalFilename,
    reason: "fixture cutover",
    now: () => FIXED_NOW
  };
}

async function createPreparedJournal(fixture: Fixture): Promise<{
  readonly candidateToml: string;
  readonly selectionId: string;
}> {
  const candidateToml = replaceStorageDbPathInToml(fixture.originalToml, fixture.candidateFilename);
  return await withTemporalCutoverLease(
    { configFilename: fixture.tomlFilename, candidateFilename: fixture.candidateFilename },
    async (lease) => {
      const journal = await createTemporalCutoverJournal(lease, fixture.journalFilename, {
        configFilename: fixture.tomlFilename,
        originalToml: fixture.originalToml,
        candidateToml,
        originalPointer: fixture.sourceFilename,
        candidatePointer: fixture.candidateFilename,
        candidateReceiptFilename: fixture.receiptFilename,
        sourceFilename: fixture.sourceFilename,
        selectionId: randomUUID(),
        createdAt: FIXED_NOW
      });
      return { candidateToml, selectionId: journal.selectionId };
    }
  );
}

function selectFixtureCandidate(fixture: Fixture, selectionId: string): void {
  const candidate = initDatabase({ filename: fixture.candidateFilename, temporalMode: "candidate" });
  try {
    selectTemporalProjection(candidate, {
      receiptFilename: fixture.receiptFilename,
      reason: "fixture interrupted selection",
      selectedAt: FIXED_NOW,
      selectionId
    });
  } finally {
    candidate.close();
  }
}

function readPointer(tomlFilename: string): string | null {
  const text = fs.readFileSync(tomlFilename, "utf8");
  const match = /^db_path\s*=\s*"(.+)"$/mu.exec(text);
  return match?.[1] ?? null;
}

function seedLegacySource(filename: string): void {
  const database = new BetterSqlite3(filename);
  try {
    database.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const markApplied = database.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
    );
    for (const migration of migrationsThrough(107)) {
      database.transaction(() => {
        database.exec(migration.sql);
        markApplied.run(migration.version, FIXED_NOW);
      })();
    }
    database.prepare(`
      INSERT INTO workspaces (
        workspace_id, name, root_path, workspace_kind,
        default_engine_binding, workspace_state, created_at, archived_at, default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "workspace-1",
      "Temporal cutover fixture",
      "/tmp/temporal-cutover-fixture",
      "local_repo",
      null,
      "active",
      FIXED_NOW,
      null,
      null
    );
  } finally {
    database.close();
  }
}

function migrationsThrough(maxVersion: number): readonly { readonly version: number; readonly sql: string }[] {
  const migrationsDirectory = fileURLToPath(new URL("../../../../../packages/storage/src/migrations", import.meta.url));
  return fs.readdirSync(migrationsDirectory)
    .map((name) => ({ name, match: /^(\d+)-.+\.sql$/u.exec(name) }))
    .filter((entry): entry is { readonly name: string; readonly match: RegExpExecArray } => entry.match !== null)
    .map(({ name, match }) => ({
      version: Number(match[1]),
      sql: fs.readFileSync(path.join(migrationsDirectory, name), "utf8")
    }))
    .filter((migration) => migration.version <= maxVersion)
    .sort((left, right) => left.version - right.version);
}

async function holdRuntimeLockInChild(sourceFilename: string): Promise<LeaseChild> {
  const lockFilename = `${sourceFilename}.temporal-runtime.lock.sqlite`;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import Database from "better-sqlite3";',
        'const database = new Database(process.env.ALAYA_TEMPORAL_TEST_LOCK_FILENAME);',
        'database.pragma("busy_timeout = 0");',
        'database.exec("BEGIN EXCLUSIVE");',
        'process.stdout.write("ready\\n");',
        "setInterval(() => database.pragma(\"schema_version\"), 1_000);"
      ].join(" ")
    ],
    {
      env: { ...process.env, ALAYA_TEMPORAL_TEST_LOCK_FILENAME: lockFilename },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  await waitForChildReady(child);
  return child;
}

async function waitForChildReady(child: LeaseChild): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error | number | null) => {
      child.stdout.off("data", ready);
      reject(error instanceof Error ? error : new Error(`Lease child exited: ${error ?? "unknown"}`));
    };
    const ready = () => {
      child.off("error", fail);
      child.off("exit", fail);
      resolve();
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stdout.once("data", ready);
  });
}
