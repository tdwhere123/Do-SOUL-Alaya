import { afterAll, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => boundary.restore());
import { solveConditionalNavigation, NAVIGATION_CONTRACT, type NavigationCondition,
  type NavigationInput, type NavigationOccurrence } from "../../../runs/source-access-diagnostic/conditional-navigation.js";

const condition = (id: string, status: NavigationCondition["status"] = "ready"): NavigationCondition =>
  ({ id, object: "same-target", hypothesis: "input-hypothesis", query: id, status,
    residual: status === "partial" ? "unresolved input fragment" : null, provenance: "authored-mechanism-fixture" });
const pool = ["a", "b", "c", "tail"].map((record_id, catalog_position) => ({ record_id, catalog_position }));
const hit = (condition: string, channel: NavigationOccurrence["channel"], record_id: string, native_rank: number): NavigationOccurrence =>
  ({ condition, channel, record_id, native_rank, reference: `${condition}:${channel}:${native_rank}`, root_key: `root:${record_id}` });
const fixture = (): NavigationInput => ({ original: "original", conditions: [condition("original")], branches: [], pool,
  occurrences: [hit("original", "lexical", "c", 8), hit("original", "lexical", "b", 40), hit("original", "vector", "a", 22)] });

describe("private navigation coordinate", () => {
  it("matches native C with rank gaps, duplicate roots, unequal lanes and a catalog tail", () => {
    const input = fixture();
    const result = solveConditionalNavigation({ ...input, occurrences: [...input.occurrences, hit("original", "vector", "c", 90)] });
    expect(result.rows.map(row => row.record_id)).toEqual(["c", "a", "b", "tail"]);
    expect(result.rows.map(row => row.navigation.tier)).toEqual([1024, 1023, 1022, null]);
    expect(result.native_single_condition).toEqual(["c", "a", "b", "tail"]);
    expect(result.single_condition_equivalent).toBe(true);
    expect(result.rows.every(row => row.read.status === "unobserved" && row.conditional_support.status === "unknown")).toBe(true);
  });

  it("takes max across operators, min across same-object conditions, and max with original", () => {
    const result = solveConditionalNavigation({ ...fixture(), conditions: [condition("original"), condition("red"), condition("round")],
      branches: [["red", "round"]], occurrences: [hit("original", "lexical", "tail", 2),
        hit("red", "lexical", "a", 1), hit("red", "lexical", "b", 2),
        hit("red", "vector", "b", 1), hit("round", "vector", "b", 7), hit("round", "vector", "a", 15)] });
    expect(result.rows.map(row => [row.record_id, row.navigation.tier])).toEqual([["tail", 1024], ["b", 1023], ["a", 1021], ["c", null]]);
    expect(result.assessments.find(row => row.record_id === "a" && row.conditions.length === 2)).toMatchObject({ status: "known", tier: 1021 });
  });

  it.each(["unknown", "unsupported", "rejected"] as const)("preserves %s without treating it as measured-low or erasing original", status => {
    const result = solveConditionalNavigation({ ...fixture(), conditions: [condition("original"), condition("missing", status)],
      branches: [["original", "missing"]] });
    expect(result.rows.map(row => row.record_id)).toEqual(["c", "a", "b", "tail"]);
    expect(result.assessments.filter(row => row.conditions.length === 2).every(row => row.status === status && row.tier === null)).toBe(true);
    expect(result.assessments.find(row => row.record_id === "b" && row.conditions.length === 1)).toMatchObject({ status: "known", tier: 1022 });
  });

  it("retains partial meaning and an unobserved required condition without inventing a conjunction", () => {
    const result = solveConditionalNavigation({ ...fixture(), conditions: [condition("original", "partial"), condition("other")],
      branches: [["original", "other"]] });
    expect(result.assessments.find(row => row.record_id === "c" && row.conditions.length === 1)).toMatchObject({ status: "partial", tier: 1024 });
    expect(result.assessments.find(row => row.record_id === "c" && row.conditions.length === 2)).toMatchObject({ status: "unknown", tier: null });
  });

  it("uses captured catalog positions for cross-branch ties and does not promise top-k preservation", () => {
    const result = solveConditionalNavigation({ ...fixture(), conditions: [condition("original"), condition("extra")], branches: [["extra"]],
      occurrences: [hit("original", "lexical", "c", 1), hit("extra", "lexical", "a", 100)] });
    expect(result.rows.map(row => row.record_id)).toEqual(["a", "c", "b", "tail"]);
    expect(result.native_single_condition[0]).toBe("c");
  });

  it("keeps different comparison objects in separate branches and rejects their conjunction", () => {
    const input = { ...fixture(), conditions: [condition("original"), { ...condition("other"), object: "compared-object" }] };
    expect(() => solveConditionalNavigation({ ...input, branches: [["original", "other"]] })).toThrow(/different compared objects/u);
    expect(() => solveConditionalNavigation({ ...input, branches: [["other"]] })).not.toThrow();
  });

  it("rejects ambiguous native ranks and nonmember identities", () => {
    const input = fixture();
    expect(() => solveConditionalNavigation({ ...input, occurrences: [...input.occurrences, hit("original", "lexical", "a", 8)] })).toThrow();
    expect(() => solveConditionalNavigation({ ...input, occurrences: [hit("original", "lexical", "outside", 1)] })).toThrow(/membership/u);
  });

  it("bounds representation before full-data use", () => {
    const conditions = [condition("original"), condition("one"), condition("two"), condition("three")];
    const members = Array.from({ length: 64 }, (_, i) => ({ record_id: String(i), catalog_position: i }));
    const result = solveConditionalNavigation({ original: "original", conditions, pool: members,
      branches: [["one", "two", "three"]], occurrences: conditions.flatMap(item => members.map((row, i) => hit(item.id, "lexical", row.record_id, i + 1))) });
    expect(result.solver.nodes).toBe(7 * 64);
    expect(result.solver.edges).toBe(384);
    expect(result.rows.map(row => row.record_id)).toEqual(members.map(row => row.record_id));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
  });
});

it("runs the real executable over a sealed SQLite family without changing the original", { timeout: 90_000 }, async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { prepareNativeSourceRecordsSnapshot } = await import("../../../runs/snapshot/source-records/native.js");
  const { StorageDatabase, SqliteSourceIndexRepository } = await import("@do-soul/alaya-storage");
  const { fieldContractSha256 } = await import("@do-soul/alaya-core");
  const { sourceIndexTarget } = await import("@do-soul/alaya-protocol");
  const { default: Database } = await import("better-sqlite3");
  const { navigationFileDigest } = await import("../../../runs/source-access-diagnostic/conditional-navigation-run.js");
  const root = mkdtempSync(join(tmpdir(), "conditional-navigation-"));
  try {
    const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, "input.sqlite"), dataDirRoot: join(root, "publish"),
      workspaceId: "navigation-fixture", runId: "navigation-fixture", producerCommit: "a".repeat(40),
      sources: ["cedar box blue stone", "red stone oak box"].map((content_bytes, i) => ({ source_id: `source-${i}`, source_version: "1", title: `Source ${i}`,
        content_bytes, source_observed_at: "2026-09-21T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z" })) });
    const connection = new Database(snapshot.snapshot_path);
    const database = new StorageDatabase(snapshot.snapshot_path, connection);
    const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
    const { SqliteFieldSourceRecordRepo } = await import("@do-soul/alaya-storage");
    for (const record of new SqliteFieldSourceRecordRepo(database, fieldContractSha256).listByWorkspace(snapshot.workspace_id)) {
      const source = sourceIndexTarget({ kind: "source_evidence", workspace_id: record.workspace_id, root_kind: "source_record",
        root_id: record.record_id, source_version: record.source_version, content_digest: record.content_digest,
        evidence_object_id: record.evidence_object_id }, record.source_id, Buffer.byteLength(record.source_body!));
      expect(repository.writeLexical(source, record.source_body!, { work: 1_000_000, native_bytes: 1_000_000 }).status).toBe("accepted");
    }
    database.close({ optimize: false });
    // Empty companions are a lawful sealed family, not evidence of an active writer.
    writeFileSync(snapshot.snapshot_path + "-wal", ""); writeFileSync(snapshot.snapshot_path + "-shm", "");
    const digest = navigationFileDigest(snapshot.snapshot_path);
    const config = { contract: NAVIGATION_CONTRACT, source_revision: "authored-boundary-fixture", channels: "lexical", cache_root: root,
      rows: [{ ordinal: 1, question_id: "fixture", snapshot: snapshot.snapshot_path, snapshot_sha256: digest,
        workspace: snapshot.workspace_id, interpretation_clock: "2026-09-22T00:00:00.000Z", authorized_scopes: ["project"], expected_index: null,
        original: "original", conditions: [{ ...condition("original"), query: "blue stone" }], branches: [] }] };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    const cli = fileURLToPath(new URL("../../../../dist/runs/source-access-diagnostic/conditional-navigation-launch.js", import.meta.url));
    const preload = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-source-embedding-offline-preload.mjs", import.meta.url).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--import", preload, cli, "--config", join(root, "config.json"), "--out", join(root, "out")],
      { encoding: "utf8", env: process.env }));
    expect(result).toMatchObject({ status: "complete", local_query_inputs: 0, external_calls: 0, index_builds: 0 });
    const output = JSON.parse(readFileSync(join(root, "out/001.json"), "utf8"));
    expect(output.solved.single_condition_equivalent).toBe(true);
    expect(output.windows[0].text).toBe("cedar box blue stone");
    expect(output.windows[0].read.status).toBe("complete");
    expect(navigationFileDigest(snapshot.snapshot_path)).toBe(digest);
    const denied = { ...config, rows: config.rows.map(row => ({ ...row, authorized_scopes: [] })) };
    writeFileSync(join(root, "denied.json"), JSON.stringify(denied));
    const empty = JSON.parse(execFileSync(process.execPath, ["--import", preload, cli, "--config", join(root, "denied.json"), "--out", join(root, "denied")],
      { encoding: "utf8", env: process.env }));
    expect(empty.status).toBe("complete");
    expect(JSON.parse(readFileSync(join(root, "denied/001.json"), "utf8")).windows).toEqual([]);
    writeFileSync(snapshot.snapshot_path + "-wal", "nonempty-unreconciled-family");
    const stopped = join(root, "stopped");
    expect(() => execFileSync(process.execPath, ["--import", preload, cli, "--config", join(root, "config.json"), "--out", stopped],
      { encoding: "utf8", env: process.env, stdio: "pipe" })).toThrow();
    expect(JSON.parse(readFileSync(join(stopped, "receipt.json"), "utf8"))).toMatchObject({ status: "stopped", local_query_inputs: 0,
      failure: "sealed export has nonempty -wal; reuse requires reconciliation" });
    expect(navigationFileDigest(snapshot.snapshot_path)).toBe(digest);
    expect(() => execFileSync(process.execPath, ["--import", preload, cli, "--config", join(root, "config.json"), "--out", join(root, "out")],
      { encoding: "utf8", env: process.env, stdio: "pipe" })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
