import BetterSqlite3 from "better-sqlite3";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAlayaOperationsService } from "../../cli/operations/operations-service.js";
import { resolveAlayaConfigPaths } from "../../cli/support/config-files.js";
import { acquireTemporalRuntimeLease } from "../../runtime/temporal-cutover/lease.js";
import * as storagePointerFile from "../../runtime/config/storage-pointer-file.js";
import { quoteTomlString } from "../support/test-paths.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "alaya-operations-wal-"));
  directories.push(directory);
  const paths = resolveAlayaConfigPaths(directory);
  const filename = path.join(directory, "alaya.db");
  await writeFile(paths.tomlPath, `[storage]\ndb_path = ${quoteTomlString(filename)}\n`);
  return { paths, filename, service: createAlayaOperationsService({ configPaths: paths }) };
}

function walDatabase(filename: string, value: string) {
  const db = new BetterSqlite3(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE example (value TEXT)");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.prepare("INSERT INTO example VALUES (?)").run(value);
  return db;
}

function values(db: BetterSqlite3.Database) {
  return db.prepare("SELECT value FROM example ORDER BY value").all();
}

async function payload(filename: string): Promise<Buffer> {
  const bundle = JSON.parse(await readFile(filename, "utf8")) as { storage: { db_base64: string } };
  return Buffer.from(bundle.storage.db_base64, "base64");
}

describe("SQLite operations snapshots", () => {
  it.each(["backup", "exportBundle"] as const)("%s includes committed WAL while the source remains open", async (operation) => {
    const f = await fixture();
    const source = walDatabase(f.filename, "committed in WAL");
    try {
      expect((await stat(`${f.filename}-wal`)).size).toBeGreaterThan(0);
      const mainCopy = path.join(f.paths.configDir, "main-only.db");
      await writeFile(mainCopy, await readFile(f.filename));
      const mainOnly = new BetterSqlite3(mainCopy);
      try { expect(values(mainOnly)).toEqual([]); } finally { mainOnly.close(); }
      const result = await f.service[operation]();
      const snapshotPath = path.join(f.paths.configDir, "snapshot.db");
      await writeFile(snapshotPath, await payload(result.artifact_path));
      const snapshot = new BetterSqlite3(snapshotPath);
      try { expect(values(snapshot)).toEqual([{ value: "committed in WAL" }]); }
      finally { snapshot.close(); }
      expect(values(source)).toEqual([{ value: "committed in WAL" }]);
    } finally { source.close(); }
  });

  it("restores through SQLite without replaying the destination's old committed WAL", async () => {
    const f = await fixture();
    const source = walDatabase(f.filename, "incoming");
    const artifact = await f.service.backup();
    source.close();
    const destination = new BetterSqlite3(f.filename);
    destination.pragma("wal_autocheckpoint = 0");
    destination.prepare("UPDATE example SET value = ?").run("old target WAL");
    try {
      expect((await stat(`${f.filename}-wal`)).size).toBeGreaterThan(0);
      await f.service.importBundle({ bundlePath: artifact.artifact_path });
      expect(values(destination)).toEqual([{ value: "incoming" }]);
    } finally { destination.close(); }
    const reopened = new BetterSqlite3(f.filename);
    try { expect(values(reopened)).toEqual([{ value: "incoming" }]); }
    finally { reopened.close(); }
  });

  it("refuses restore under a daemon lease before changing config or database", async () => {
    const f = await fixture();
    const source = walDatabase(f.filename, "incoming");
    const artifact = await f.service.backup();
    source.prepare("UPDATE example SET value = ?").run("live");
    await writeFile(f.paths.envPath, "KEEP=unchanged\n");
    const configBefore = await readFile(f.paths.tomlPath, "utf8");
    const lease = await acquireTemporalRuntimeLease(f.filename);
    try {
      await expect(f.service.importBundle({ bundlePath: artifact.artifact_path })).rejects.toThrow("must be stopped");
      expect(values(source)).toEqual([{ value: "live" }]);
      expect(await readFile(f.paths.tomlPath, "utf8")).toBe(configBefore);
      expect(await readFile(f.paths.envPath, "utf8")).toBe("KEEP=unchanged\n");
    } finally { await lease.release(); source.close(); }
  });

  it("rejects an invalid incoming database before mutating the active files", async () => {
    const f = await fixture();
    const source = walDatabase(f.filename, "keep");
    const artifact = await f.service.backup();
    const bundle = JSON.parse(await readFile(artifact.artifact_path, "utf8"));
    bundle.storage.db_base64 = Buffer.from("invalid database").toString("base64");
    bundle.config.env_file = "REPLACE=yes\n";
    await writeFile(artifact.artifact_path, JSON.stringify(bundle));
    await writeFile(f.paths.envPath, "KEEP=yes\n");
    const configBefore = await readFile(f.paths.tomlPath, "utf8");
    try {
      await expect(f.service.importBundle({ bundlePath: artifact.artifact_path })).rejects.toThrow();
      expect(values(source)).toEqual([{ value: "keep" }]);
      expect(await readFile(f.paths.tomlPath, "utf8")).toBe(configBefore);
      expect(await readFile(f.paths.envPath, "utf8")).toBe("KEEP=yes\n");
    } finally { source.close(); }
  });

  it("does not create a destination for an invalid incoming database", async () => {
    const f = await fixture();
    const artifact = await f.service.backup();
    const bundle = JSON.parse(await readFile(artifact.artifact_path, "utf8"));
    bundle.storage.db_base64 = Buffer.from("invalid database").toString("base64");
    bundle.config.env_file = "REPLACE=yes\n";
    await writeFile(artifact.artifact_path, JSON.stringify(bundle));
    const configBefore = await readFile(f.paths.tomlPath, "utf8");
    await expect(f.service.importBundle({ bundlePath: artifact.artifact_path })).rejects.toThrow();
    await expect(stat(f.filename)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.paths.envPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.paths.tomlPath, "utf8")).toBe(configBefore);
    const audits = await readdir(f.paths.auditDir);
    const auditFilename = audits.find((filename) => filename.startsWith("import-"))!;
    expect(JSON.parse(await readFile(path.join(f.paths.auditDir, auditFilename), "utf8")))
      .toMatchObject({ status: "failed", partial_state: [] });
  });

  it("records a restored database when a later config write fails", async () => {
    const f = await fixture();
    const source = walDatabase(f.filename, "incoming");
    const artifact = await f.service.backup();
    source.prepare("UPDATE example SET value = ?").run("old");
    const originalWrite = storagePointerFile.writeTextAtomic;
    vi.spyOn(storagePointerFile, "writeTextAtomic").mockImplementation(async (filename, content, mode) => {
      if (filename === f.paths.tomlPath) throw new Error("config write failed");
      await originalWrite(filename, content, mode);
    });
    try {
      await expect(f.service.importBundle({ bundlePath: artifact.artifact_path })).rejects.toThrow("config write failed");
      expect(values(source)).toEqual([{ value: "incoming" }]);
      const audits = await readdir(f.paths.auditDir);
      const auditFilename = audits.find((filename) => filename.startsWith("import-"))!;
      expect(JSON.parse(await readFile(path.join(f.paths.auditDir, auditFilename), "utf8")))
        .toMatchObject({ status: "failed", partial_state: [f.filename], error: "config write failed" });
    } finally { source.close(); }
  });

  it("keeps absent databases absent and backs up an empty database", async () => {
    const f = await fixture();
    const missing = await f.service.backup();
    expect(JSON.parse(await readFile(missing.artifact_path, "utf8")).storage.db_base64).toBeNull();
    await expect(stat(f.filename)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(f.filename, Buffer.alloc(0));
    const empty = await f.service.exportBundle();
    const db = new BetterSqlite3(await payload(empty.artifact_path));
    try { expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]); }
    finally { db.close(); }
  });

  it("audits invalid SQLite as failed instead of exporting raw corrupt bytes", async () => {
    const f = await fixture();
    await writeFile(f.filename, "not SQLite");
    await expect(f.service.backup({ outputPath: path.join(f.paths.configDir, "bad.json") })).rejects.toThrow();
    await expect(stat(path.join(f.paths.configDir, "bad.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const audits = await readdir(f.paths.auditDir);
    const audit = JSON.parse(await readFile(path.join(f.paths.auditDir, audits[0]!), "utf8"));
    expect(audit).toMatchObject({ status: "failed", partial_state: [] });
    expect(audit.error).toMatch(/database/i);
  });
});
