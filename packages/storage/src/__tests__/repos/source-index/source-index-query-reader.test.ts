import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetCjkSegmentationStateForTests } from "@do-soul/alaya-cjk-segmentation";
import { splitFtsLanes } from "@do-soul/alaya-protocol";
import { SqliteFieldEraseBarrierRepo } from "../../../repos/field/erase-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { tokenizeFtsQuery } from "../../../repos/shared/fts-lane-routing.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import { initDatabase, StorageDatabase } from "../../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../../sqlite/temporal-cutover-gate.js";
import { applyBaselineSql, currentSchemaVersion } from "../../migrations/apply-baseline.js";
import { CLOCK, fieldSha256, seedWorkspaces } from "../field/field-contract-fixture.js";
import {
  BUDGET, QUERY_BUDGET, WORKSPACE, LEXICAL_LIMITATIONS, expectQueryResources, fixture, laneMatch,
  publishIndexed, rankedLane, rankedUnicode61Unscoped, targetFor, vectorWindowIds, type Fixture
} from "./source-index-query-fixture.js";
import { buildReady, eraseSource, publishSource } from "./source-index-fixture.js";

const environments: Fixture[] = [];
const databases: StorageDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const environment of environments.splice(0)) environment.database.close();
  for (const database of databases.splice(0)) database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}
function lexical(environment: Fixture, query: string, limit = 8) {
  return environment.index.readLexicalCandidates(WORKSPACE, query, limit, QUERY_BUDGET);
}
function porterMatch(query: string) {
  return laneMatch(splitFtsLanes(tokenizeFtsQuery(query)).porterTokens);
}
function trigramMatch(query: string) {
  return laneMatch(splitFtsLanes(tokenizeFtsQuery(query)).trigramTokens);
}
function floatBlob(values: readonly number[]): Buffer {
  const blob = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => blob.writeFloatLE(value, index * 4));
  return blob;
}

describe("source index lexical SQLite ranking and admission limits", () => {
  it("orders a unicode61 lane by independent BM25 then root_key and does not fuse trigram scores", () => {
    const environment = setup();
    const frequent = publishIndexed(environment, "alpha alpha alpha alpha frequent-marker", "frequent");
    const rare = publishIndexed(environment, "alpha once-only rare-marker", "rare");
    publishIndexed(environment, "部署流水线配置说明 trigram-only-body", "cjk");
    const query = "alpha";
    const expected = rankedLane(environment.database, "source_index_fts", WORKSPACE, porterMatch(query));
    expect(expected.map(row => row.root_key)).toEqual([frequent.source.root_key, rare.source.root_key]);
    expect(expected[0]!.score).toBeLessThan(expected[1]!.score);
    const read = lexical(environment, query, 8);
    expectQueryResources(read.resources);
    expect(read.index_coverage).toBe("partial");
    expect(read.limitations).toEqual(LEXICAL_LIMITATIONS);
    expect(read.completion).toBe("complete");
    expect(read.reason).toBeNull();
    expect(read.candidates.map(candidate => candidate.source.root_key)).toEqual(expected.map(row => row.root_key));
    expect(read.candidates.every(candidate => candidate.lexical.lane === "unicode61")).toBe(true);
    expect(read.candidates.map(candidate => candidate.lexical.lane_rank)).toEqual([1, 2]);
    const mixedQuery = "alpha 部署流水线";
    const mixedSplit = splitFtsLanes(tokenizeFtsQuery(mixedQuery));
    expect(mixedSplit.porterTokens.length).toBeGreaterThan(0);
    expect(mixedSplit.trigramTokens.length).toBeGreaterThan(0);
    const mixed = lexical(environment, mixedQuery, 2);
    expect(mixed.completion).toBe("partial");
    expect(mixed.reason).toBe("candidate_limit");
    expect(mixed.index_coverage).toBe("partial");
    expect(mixed.candidates.map(candidate => candidate.lexical.lane)).toEqual(["unicode61", "trigram"]);
    expect(mixed.candidates[0]!.source.root_key).toBe(
      rankedLane(environment.database, "source_index_fts", WORKSPACE, laneMatch(mixedSplit.porterTokens))[0]!.root_key
    );
    expect(mixed.candidates[1]!.source.root_key).toBe(
      rankedLane(environment.database, "source_index_fts_trigram", WORKSPACE, laneMatch(mixedSplit.trigramTokens))[0]!.root_key
    );
  });

  it("breaks equal BM25 scores with root_key ascending inside the same lane", () => {
    const environment = setup();
    const first = publishIndexed(environment, "shared alpha phrase", "tie-a");
    const second = publishIndexed(environment, "shared alpha phrase", "tie-b");
    const expected = rankedLane(environment.database, "source_index_fts", WORKSPACE, porterMatch("alpha"));
    expect(new Set(expected.map(row => row.root_key))).toEqual(new Set([first.source.root_key, second.source.root_key]));
    expect(expected[0]!.score).toBe(expected[1]!.score);
    expect(expected.map(row => row.root_key)).toEqual(
      [first.source.root_key, second.source.root_key].sort((left, right) => left < right ? -1 : 1)
    );
    const read = lexical(environment, "alpha", 8);
    expect(read.candidates.map(candidate => candidate.source.root_key)).toEqual(expected.map(row => row.root_key));
    expect(read.candidates[0]!.lexical.bm25).toBe(read.candidates[1]!.lexical.bm25);
  });

  it("applies workspace membership before LIMIT even when a foreign row has a stronger BM25", () => {
    const environment = setup();
    const local = publishIndexed(environment, "alpha local-once", "local");
    const foreign = publishIndexed(environment, "alpha alpha alpha alpha alpha foreign-strong", "foreign", {
      workspace_id: "workspace-2"
    });
    const unscoped = rankedUnicode61Unscoped(environment.database, porterMatch("alpha"));
    expect(unscoped[0]).toMatchObject({ workspace_id: "workspace-2", root_key: foreign.source.root_key });
    expect(unscoped.some(row => row.workspace_id === WORKSPACE && row.root_key === local.source.root_key)).toBe(true);
    const read = lexical(environment, "alpha", 1);
    expect(read.completion).toBe("partial");
    expect(read.reason).toBe("candidate_limit");
    expect(read.index_coverage).toBe("partial");
    expect(read.candidates).toHaveLength(1);
    expect(read.candidates[0]!.source.root_key).toBe(local.source.root_key);
    expect(read.candidates[0]!.source.target.workspace_id).toBe(WORKSPACE);
    expect(environment.index.readLexicalCandidates("workspace-2", "alpha", 1, QUERY_BUDGET)
      .candidates.map(candidate => candidate.source.root_key)).toEqual([foreign.source.root_key]);
  });

  it("quotes FTS operators and quote marks so MATCH stays a literal token search", () => {
    const environment = setup();
    const operators = publishIndexed(environment, 'he said "alpha" AND OR NEAR', "ops");
    publishIndexed(environment, "unrelated beta document", "other");
    for (const query of ["AND", "OR", "NEAR", 'alpha"', 'alpha" OR nonexistent']) {
      expect(() => lexical(environment, query, 8)).not.toThrow();
    }
    const andRead = lexical(environment, "AND", 8);
    expectQueryResources(andRead.resources);
    expect(andRead.completion).not.toBe("unavailable");
    expect(andRead.candidates.map(candidate => candidate.source.root_key)).toEqual([operators.source.root_key]);
    expect(andRead.candidates.map(candidate => candidate.source.root_key))
      .toEqual(rankedLane(environment.database, "source_index_fts", WORKSPACE, porterMatch("AND")).map(row => row.root_key));
    const quoted = lexical(environment, '"alpha"', 8);
    expect(quoted.candidates.map(candidate => candidate.source.root_key)).toEqual([operators.source.root_key]);
  });

  it("treats short or unadmitted tokens as an explicit limitation, not source absence", () => {
    const environment = setup();
    const latin = publishIndexed(environment, "alpha token exists", "latin");
    publishIndexed(environment, "部署流水线配置说明", "cjk");
    expect(tokenizeFtsQuery("a")).toEqual([]);
    expect(tokenizeFtsQuery("部")).toEqual([]);
    const absent = lexical(environment, "zzzznotpresent", 8);
    expect(absent.candidates).toEqual([]);
    expect(absent.completion).toBe("complete");
    const short = lexical(environment, "a", 8);
    expect(short).toMatchObject({
      candidates: [], completion: "partial", reason: "no_admitted_tokens", index_coverage: "partial"
    });
    expect(short.limitations).toEqual(LEXICAL_LIMITATIONS);
    expect(short.limitations).toContain("short_or_unadmitted_tokens_are_not_absence");
    expectQueryResources(short.resources);
    expect(lexical(environment, "部", 8).reason).toBe("no_admitted_tokens");
    const present = lexical(environment, "alpha", 8);
    expect(present.candidates.map(candidate => candidate.source.root_key)).toEqual([latin.source.root_key]);
    expect(present.index_coverage).toBe("partial");
  });

  it("refuses invalid limits, charges a zero budget as read_budget, and keeps SQL internal work unknown", () => {
    const environment = setup();
    publishIndexed(environment, "alpha present", "latin");
    expect(() => environment.index.readLexicalCandidates(WORKSPACE, "alpha", 0, QUERY_BUDGET))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => environment.index.readLexicalCandidates(WORKSPACE, "alpha", 129, QUERY_BUDGET))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    const exhausted = environment.index.readLexicalCandidates(WORKSPACE, "alpha", 8, { work_units: 0, memory_bytes: 0 });
    expect(exhausted).toMatchObject({ completion: "partial", reason: "read_budget", index_coverage: "partial" });
    expectQueryResources(exhausted.resources, { work_units: 0, memory_bytes: 0 });
    expect(exhausted.resources.sql_internal_work).toBe("unknown");
    expect(exhausted.candidates).toEqual([]);
  });
});

describe("source index short CJK exact unicode61 and trigram SQLite admission", () => {
  beforeEach(() => {
    __resetCjkSegmentationStateForTests();
  });
  afterEach(() => {
    __resetCjkSegmentationStateForTests();
  });

  it("keeps a 2-codepoint 部署 exact hit, ignores embedded 系统部署完成, and does not report ordinary complete-empty", () => {
    const environment = setup();
    const embedded = publishIndexed(environment, "系统部署完成", "embedded");
    const empty = lexical(environment, "部署");
    expect(rankedLane(environment.database, "source_index_fts", WORKSPACE, laneMatch(["部署"]))).toEqual([]);
    expect(empty.candidates).toEqual([]);
    expect(empty).toMatchObject({
      completion: "partial", reason: "short_cjk_exact_tokens_only", index_coverage: "partial"
    });
    expect(empty.limitations).toEqual([...LEXICAL_LIMITATIONS, "short_cjk_unicode61_exact_tokens_only"]);
    expectQueryResources(empty.resources);
    const absent = lexical(environment, "zzzznotpresent");
    expect(absent).toMatchObject({ candidates: [], completion: "complete", reason: null });
    expect(absent.limitations).toEqual(LEXICAL_LIMITATIONS);
    const exact = publishIndexed(environment, "部署", "exact");
    const expected = rankedLane(environment.database, "source_index_fts", WORKSPACE, laneMatch(["部署"]));
    expect(expected.map(row => row.root_key)).toEqual([exact.source.root_key]);
    expect(expected.some(row => row.root_key === embedded.source.root_key)).toBe(false);
    const read = lexical(environment, "部署");
    expect(read.candidates.map(candidate => candidate.source.root_key)).toEqual([exact.source.root_key]);
    expect(read.candidates[0]).toMatchObject({ lexical: { lane: "unicode61", lane_rank: 1 } });
    expect(read).toMatchObject({
      completion: "partial", reason: "short_cjk_exact_tokens_only", index_coverage: "partial"
    });
    expect(read.limitations).toEqual([...LEXICAL_LIMITATIONS, "short_cjk_unicode61_exact_tokens_only"]);
    expect(read.tokenization).toMatchObject({
      policy: "source-index-fts.v1", terms: ["部署"], unicode61_terms: ["部署"], trigram_terms: []
    });
  });

  it("keeps >=3 CJK queries on the trigram lane, including an embedded overlapping body", () => {
    const environment = setup();
    const embedded = publishIndexed(environment, "系统部署流水线完成", "embedded-long");
    const standalone = publishIndexed(environment, "部署流水线", "standalone-long");
    publishIndexed(environment, "配置说明无关正文", "unrelated");
    const expected = rankedLane(
      environment.database, "source_index_fts_trigram", WORKSPACE, laneMatch(["部署流水线"])
    );
    expect(new Set(expected.map(row => row.root_key)))
      .toEqual(new Set([embedded.source.root_key, standalone.source.root_key]));
    expect(rankedLane(environment.database, "source_index_fts", WORKSPACE, laneMatch(["部署流水线"]))
      .map(row => row.root_key)).toEqual([standalone.source.root_key]);
    const read = lexical(environment, "部署流水线");
    expectQueryResources(read.resources);
    expect(read.candidates.map(candidate => candidate.source.root_key)).toEqual(expected.map(row => row.root_key));
    expect(read.candidates.every(candidate => candidate.lexical.lane === "trigram")).toBe(true);
    expect(read).toMatchObject({ completion: "complete", reason: null, index_coverage: "partial" });
    expect(read.limitations).toEqual(LEXICAL_LIMITATIONS);
    expect(read.tokenization).toMatchObject({
      policy: "source-index-fts.v1", terms: ["部署流水线"], unicode61_terms: [], trigram_terms: ["部署流水线"]
    });
  });
});

describe("source index CJK trigram migration rebuild and mutation", () => {
  it("rebuilds trigram from 021-populated native text and follows updates, deletes, and erase", () => {
    const directory = mkdtempSync(join(tmpdir(), "source-index-query-021-"));
    directories.push(directory);
    const filename = join(directory, "source.sqlite");
    const old = new StorageDatabase(filename, new BetterSqlite3(filename));
    databases.push(old);
    applyBaselineSql(old.connection, 21);
    migrateLegacyPathRelationsToTemporalCandidate(old.connection, { selectionRequired: false });
    old.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const mark = old.connection.prepare("INSERT INTO schema_version VALUES (?, ?)");
    for (let version = 1; version <= 21; version += 1) mark.run(version, CLOCK);
    seedWorkspaces(old);
    old.connection.pragma("foreign_keys = ON");
    const foundation: Fixture = {
      database: old, records: new SqliteFieldSourceRecordRepo(old, fieldSha256),
      index: new SqliteSourceIndexRepository(old, fieldSha256),
      erase: new SqliteFieldEraseBarrierRepo(old, fieldSha256)
    };
    const originalBody = "部署流水线配置说明";
    // Author the historical 021 projection layout, not today's expanded-root writer.
    const record = publishSource(foundation, originalBody, "cjk-root");
    const published = { record, source: targetFor(record) };
    old.connection.prepare(`INSERT INTO source_index_roots(workspace_id,root_key,record_id,source_id,target_json)
      VALUES(?,?,?,?,?)`).run(WORKSPACE, published.source.root_key, record.record_id, record.source_id, JSON.stringify(published.source));
    old.connection.prepare(`INSERT INTO source_index_text(workspace_id,root_key,content_digest,body_bytes,body)
      VALUES(?,?,?,?,?)`).run(WORKSPACE, published.source.root_key, record.content_digest, published.source.body_bytes, originalBody);
    expect(old.connection.prepare("SELECT name FROM sqlite_master WHERE name='source_index_fts_trigram'").get())
      .toBeUndefined();
    expect(old.connection.prepare("SELECT body FROM source_index_text WHERE workspace_id=? AND root_key=?")
      .get(WORKSPACE, published.source.root_key)).toEqual({ body: originalBody });
    old.close({ optimize: false });
    const migrated = initDatabase({ filename });
    databases.push(migrated);
    expect(migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get())
      .toEqual({ version: currentSchemaVersion() });
    expect(migrated.connection.prepare("SELECT name FROM sqlite_master WHERE name='source_index_fts_trigram'").get())
      .toEqual({ name: "source_index_fts_trigram" });
    const environment: Fixture = {
      database: migrated, records: new SqliteFieldSourceRecordRepo(migrated, fieldSha256),
      index: new SqliteSourceIndexRepository(migrated, fieldSha256),
      erase: new SqliteFieldEraseBarrierRepo(migrated, fieldSha256)
    };
    const query = "部署流水线";
    const rebuilt = rankedLane(migrated, "source_index_fts_trigram", WORKSPACE, trigramMatch(query));
    expect(rebuilt.map(row => row.root_key)).toEqual([published.source.root_key]);
    const read = environment.index.readLexicalCandidates(WORKSPACE, query, 8, QUERY_BUDGET);
    expect(read.candidates.some(candidate => candidate.lexical.lane === "trigram"
      && candidate.source.root_key === published.source.root_key)).toBe(true);
    const updatedBody = "更新后的流水线配置文本";
    const replacement = publishSource(environment, updatedBody, "cjk-root", {
      source_version: "v2", recorded_at: "2026-09-22T00:00:00Z"
    });
    const updated = targetFor(replacement);
    expect(rankedLane(migrated, "source_index_fts_trigram", WORKSPACE, trigramMatch(query))).toEqual([]);
    expect(environment.index.writeLexical(updated, updatedBody, BUDGET).status).toBe("accepted");
    expect(rankedLane(migrated, "source_index_fts_trigram", WORKSPACE, trigramMatch("流水线配置"))
      .map(row => row.root_key)).toEqual([updated.root_key]);
    expect(migrated.connection.prepare("DELETE FROM source_index_text WHERE workspace_id=? AND root_key=?")
      .run(WORKSPACE, updated.root_key).changes).toBe(1);
    expect(rankedLane(migrated, "source_index_fts_trigram", WORKSPACE, trigramMatch("流水线配置"))).toEqual([]);
    expect(environment.index.writeLexical(updated, updatedBody, BUDGET).status).toBe("accepted");
    eraseSource(environment, replacement.record_id);
    expect(rankedLane(migrated, "source_index_fts_trigram", WORKSPACE, trigramMatch("流水线配置"))).toEqual([]);
    expect(environment.records.findById(WORKSPACE, replacement.record_id)?.source_body).toBeNull();
  }, process.platform === "win32" ? 180_000 : 60_000);
});

describe("source index vector scan, invalid payloads, and cursors", () => {
  it("scans active windows in window_id order independently of text MATCH and pages by cursor", () => {
    const environment = setup();
    publishSource(environment, "zzzz unranked unique body");
    publishSource(environment, "another zzzz window source", "source-b");
    const ready = buildReady(environment);
    const generationId = ready.generation.generation_id;
    const expected = vectorWindowIds(environment.database, WORKSPACE, generationId);
    expect(expected.length).toBeGreaterThan(1);
    expect(rankedLane(environment.database, "source_index_fts", WORKSPACE, porterMatch("alpha"))).toEqual([]);
    const page = environment.index.readVectorCandidates(WORKSPACE, null, 1, QUERY_BUDGET);
    expectQueryResources(page.resources);
    expect(page.state).toMatchObject({ status: "ready" });
    expect(page.completion).toBe("partial");
    expect(page.reason).toBe("window_page_limit");
    expect(page.inspected).toBe(1);
    expect(page.invalid).toBe(0);
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]!.window.window_id).toBe(expected[0]);
    expect(Array.from(page.candidates[0]!.embedding)).toEqual(Array.from(new Float32Array([0.6, 0.8, 0])));
    expect(page.cursor).toEqual({
      binding: "binding" in page.state ? page.state.binding : null, after_window_id: expected[0]
    });
    const next = environment.index.readVectorCandidates(WORKSPACE, page.cursor, 1, QUERY_BUDGET);
    expect(next.candidates[0]!.window.window_id).toBe(expected[1]);
    expect(next.cursor?.after_window_id).toBe(expected[1]);
    const rest = environment.index.readVectorCandidates(WORKSPACE, next.cursor, 128, QUERY_BUDGET);
    expect(rest.candidates.map(candidate => candidate.window.window_id)).toEqual(expected.slice(2));
    if (expected.length - 2 < 128) {
      expect(rest.completion).toBe("complete");
      expect(rest.reason).toBeNull();
    } else {
      expect(rest.completion).toBe("partial");
      expect(rest.reason).toBe("window_page_limit");
    }
    expect(rest.inspected).toBe(expected.length - 2);
    const exhausted = environment.index.readVectorCandidates(WORKSPACE, null, 8, { work_units: 0, memory_bytes: 0 });
    expect(exhausted).toMatchObject({ completion: "partial", reason: "read_budget" });
    expect(exhausted.candidates).toEqual([]);
    expect(exhausted.resources.sql_internal_work).toBe("unknown");
    expect(() => environment.index.readVectorCandidates(WORKSPACE, null, 0, QUERY_BUDGET))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("counts malformed blobs, dimension mismatches, and invalid windows as invalid/partial without dropping the scan", () => {
    const environment = setup();
    publishSource(environment, "guarded vector input");
    const ready = buildReady(environment);
    const windows = ready.documents[0]!.windows;
    expect(windows.length).toBeGreaterThanOrEqual(3);
    const [zeroId, nanId, boundId] = windows.map(window => window.window_id);
    environment.database.connection.prepare("UPDATE source_index_vectors SET embedding_blob=? WHERE window_id=?")
      .run(floatBlob([0, 0, 0]), zeroId);
    environment.database.connection.prepare("UPDATE source_index_vectors SET embedding_blob=? WHERE window_id=?")
      .run(floatBlob([Number.NaN, 0, 0]), nanId);
    environment.database.connection.prepare("UPDATE source_index_vectors SET dimensions=2, embedding_blob=? WHERE window_id=?")
      .run(floatBlob([0.6, 0.8]), windows[2]!.window_id);
    const malformed = environment.index.readVectorCandidates(WORKSPACE, null, 128, QUERY_BUDGET);
    expect(malformed.completion).toBe("partial");
    expect(malformed.reason).toBe("invalid_vectors");
    expect(malformed.invalid).toBe(3);
    expect(malformed.inspected).toBe(3);
    expect(malformed.candidates).toEqual([]);
    expect(malformed.resources.sql_internal_work).toBe("unknown");
    environment.database.connection.prepare("UPDATE source_index_vectors SET dimensions=3, embedding_blob=? WHERE window_id=?")
      .run(floatBlob([0.6, 0.8, 0]), windows[2]!.window_id);
    environment.database.connection.prepare("UPDATE source_index_windows SET end_byte=start_byte WHERE window_id=?")
      .run(boundId);
    const bounded = environment.index.readVectorCandidates(WORKSPACE, null, 128, QUERY_BUDGET);
    expect(bounded).toMatchObject({ completion: "partial", reason: "invalid_vectors", invalid: 3, inspected: 3 });
    expect(bounded.candidates).toEqual([]);
    const firstInvalid = environment.index.readVectorCandidates(WORKSPACE, null, 1, QUERY_BUDGET);
    expect(firstInvalid).toMatchObject({ completion: "partial", reason: "window_page_limit", inspected: 1, invalid: 1 });
    expect(firstInvalid.candidates).toEqual([]);
    expect(firstInvalid.cursor?.after_window_id).toBe(
      vectorWindowIds(environment.database, WORKSPACE, ready.generation.generation_id)[0]
    );
  });
});
