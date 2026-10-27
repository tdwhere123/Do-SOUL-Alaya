import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { sourceIndexTarget, SourceIndexTargetSchema, SourceIndexOperationError } from "@do-soul/alaya-protocol";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteSourceRootRecallReader } from "../../../repos/field/bounded-source-root-reader.js";
import { BUDGET, CLOCK, WORKSPACE, buildReady, configuration, fixture, publishSource, type Fixture } from "./source-index-fixture.js";
import { QUERY_BUDGET } from "./source-index-query-fixture.js";

const opened: Fixture[] = [];
afterEach(() => { for (const env of opened.splice(0)) env.database.close(); });
function setup() { const env = fixture(); opened.push(env); return env; }
async function capsule(env: Fixture, excerpt: string | null = "needle 😀 original", lifecycle_state: "active" | "archived" = "active",
  eventTime?: string) {
  return new SqliteEvidenceCapsuleRepo(env.database).create({ object_id: randomUUID(), object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state, created_at: CLOCK, updated_at: CLOCK, created_by: "user_action", evidence_kind: "conversation_excerpt",
    semantic_anchor: { topic: "source", keywords: ["source"], summary: "retained source" },
    event_anchor: eventTime === undefined ? null : { event_type: "engine.response.received", event_id: "observed-event", occurred_at: eventTime },
    physical_anchor: null, evidence_health_state: "verified", gist: excerpt === null ? "needle 😀 fallback" : "gist",
    excerpt, source_hash: "not-the-retained-digest", run_id: "run-1", workspace_id: WORKSPACE, surface_id: null });
}
function lexical(env: Fixture) { return env.index.readLexicalCandidates(WORKSPACE, "needle", 16, QUERY_BUDGET); }

describe("native retained capsule SourceIndex roots", () => {
  it("uses retained source event time for calendar preference, never capsule creation time", async () => {
    const env = setup();
    const dated = await capsule(env, "needle dated", "active", "2020-01-02T23:59:59.999Z");
    await capsule(env, "needle unknown");
    const { documents } = buildReady(env);
    const preference = { interpretation_clock: CLOCK, intervals: [{ start: "2020-01-02", end: "2020-01-02" }] };
    const result = env.index.readLexicalCandidates(WORKSPACE, "needle", 16, QUERY_BUDGET, preference);
    expect(result.candidates.map(row => row.source.target.root_id)).toEqual([dated.object_id]);
    const keys = documents.map(document => document.source.root_key);
    const matched = documents.find(document => document.source.target.root_id === dated.object_id)!.source.root_key;
    expect(env.index.readQuestionTimeDomain(WORKSPACE, preference, keys, QUERY_BUDGET))
      .toMatchObject({ status: "ready", exists: true, matched_root_keys: [matched] });
    expect(env.index.readQuestionTimeDomain("foreign", preference, keys, QUERY_BUDGET))
      .toMatchObject({ status: "ready", exists: false, matched_root_keys: [] });
    expect(env.index.readQuestionTimeDomain(WORKSPACE,
      { ...preference, intervals: [{ start: CLOCK.slice(0, 10), end: CLOCK.slice(0, 10) }] }, keys, QUERY_BUDGET))
      .toMatchObject({ status: "ready", exists: false, matched_root_keys: [] });
  });

  it.each(["needle 😀 original", null])("indexes retained text without a mirror and resumes exact windows: %s", async excerpt => {
    const env = setup(); const root = await capsule(env, excerpt);
    expect(lexical(env).candidates).toEqual([]);
    const { generation, documents } = buildReady(env);
    expect(generation).toMatchObject({ preparation_revision: 2, records_complete: true, enumeration_complete: true });
    const source = documents[0]!.source;
    expect(source).toMatchObject({ source_id: null, target: { root_kind: "evidence_capsule", root_id: root.object_id,
      source_version: CLOCK, evidence_object_id: root.object_id } });
    expect(documents[0]!.body).toBe(excerpt ?? "needle 😀 fallback");
    expect(lexical(env).candidates.map(row => row.source)).toContainEqual(source);
    expect(env.index.admitQueryCandidate(source, null, QUERY_BUDGET)).toMatchObject({ status: "ready", scope_class: null });
    expect(env.database.connection.prepare("SELECT count(*) AS n FROM source_records").get()).toEqual({ n: 0 });
    expect(env.database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    const reader = new SqliteSourceRootRecallReader(env.records, new SqliteEvidenceCapsuleRepo(env.database));
    expect(reader.load(WORKSPACE, source.target).row).toMatchObject({ content: documents[0]!.body,
      retained_extent: excerpt === null ? "gist" : "excerpt", original_complete: false, event_time: null });
    expect(reader.load("foreign", source.target).row).toBeNull();
    for (const target of [{ ...source.target, source_version: "old" }, { ...source.target, content_digest: `sha256:${"f".repeat(64)}` }]) {
      expect(env.index.admitQueryCandidate(sourceIndexTarget(target, null, source.body_bytes), null, QUERY_BUDGET).status).toBe("stale");
    }
    expect(SourceIndexTargetSchema.safeParse({ ...source, source_id: "invented" }).success).toBe(false);
    expect(env.index.pendingWindows(WORKSPACE, generation.generation_id, source.root_key, 16, BUDGET)).toMatchObject({ status: "ready", ordinals: [] });
  });

  it("charges rejected capsules and persists each family cursor without declaring budget exhaustion empty", async () => {
    const env = setup(); publishSource(env, "record control");
    await capsule(env, "inactive needle", "archived"); const root = await capsule(env);
    const generation = env.index.begin(env.index.select(WORKSPACE, configuration()));
    const refused = env.index.capturePage(WORKSPACE, generation.generation_id, 1, { work: 0, native_bytes: 0 });
    expect(refused).toMatchObject({ added: 0, generation: { enumeration_complete: false, reason: "enumeration_budget" } });
    const visited = [];
    for (let i = 0; i < 8; i++) {
      const page = env.index.capturePage(WORKSPACE, generation.generation_id, 1, BUDGET); visited.push(page);
      expect(page.resources.work).toBeGreaterThan(0);
      expect(page.resources.work).toBeLessThanOrEqual(BUDGET.work);
      expect(page.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
      if (page.generation.enumeration_complete) break;
    }
    expect(visited.at(-1)!.generation).toMatchObject({ enumeration_complete: true, target_count: 2 });
    expect(visited.some(page => page.added === 0 && page.resources.native_bytes > 0)).toBe(true);
    expect(env.index.listTargets(WORKSPACE, generation.generation_id, null, 16).some(row => row.target.root_id === root.object_id)).toBe(true);
  });

  it.each(["missing", "revision", "digest", "bytes"])("does not use stale lexical text when retained chunks are %s", async fault => {
    const env = setup(); const root = await capsule(env); const { documents } = buildReady(env); const source = documents[0]!.source;
    const db = env.database.connection;
    if (fault === "missing") db.prepare("DELETE FROM retained_source_chunks WHERE root_id=?").run(root.object_id);
    else if (fault === "revision") db.prepare("UPDATE retained_source_chunks SET source_revision='old' WHERE root_id=?").run(root.object_id);
    else if (fault === "digest") db.prepare("UPDATE retained_source_chunks SET content_digest='wrong' WHERE root_id=?").run(root.object_id);
    else db.prepare("UPDATE retained_source_chunks SET body=x'626164' WHERE root_id=?").run(root.object_id);
    expect(env.index.admitQueryCandidate(source, null, QUERY_BUDGET).status).toBe("partial");
    const generation = env.index.state(WORKSPACE);
    if (!("active_generation_id" in generation) || generation.active_generation_id === null) throw new Error("expected a captured generation");
    expect(env.index.readDocument(WORKSPACE, generation.active_generation_id, source.root_key, 65536, BUDGET).status).toBe("partial");
    expect(env.index.writeLexical(source, documents[0]!.body, BUDGET).status).toBe("rejected");
  });

  it.each(["revision", "archive", "tombstone", "delete"])("invalidates capsule projections on native %s", async mutation => {
    const env = setup(); const root = await capsule(env); const { generation, documents } = buildReady(env);
    if (mutation === "delete") await new SqliteEvidenceCapsuleRepo(env.database).deleteById(root.object_id);
    else env.database.connection.prepare(mutation === "revision"
      ? "UPDATE evidence_capsules SET updated_at='2090-01-01T00:00:00Z' WHERE object_id=?"
      : "UPDATE evidence_capsules SET lifecycle_state=? WHERE object_id=?")
      .run(...(mutation === "revision" ? [root.object_id] : [mutation === "archive" ? "archived" : "tombstone", root.object_id]));
    expect(lexical(env).candidates).toEqual([]);
    expect(env.index.generation(WORKSPACE, generation.generation_id)?.status).toBe("partial");
    expect(env.index.admitQueryCandidate(documents[0]!.source, null, QUERY_BUDGET).status).not.toBe("ready");
    expect(env.database.connection.prepare("SELECT count(*) AS n FROM source_index_vectors").get()).toEqual({ n: 0 });
  });

  it("keeps invalidation identities kind-aware and retires standalone eligibility when a native record binds the capsule", async () => {
    const env = setup(); const root = await capsule(env); const { documents } = buildReady(env);
    const source = documents[0]!.source;
    env.database.connection.prepare("INSERT INTO source_index_invalidations VALUES(?,?,?,NULL)")
      .run(WORKSPACE, "source_record", root.object_id);
    expect(lexical(env).candidates.map(row => row.source)).toContainEqual(source);
    expect(env.index.admitQueryCandidate(source, null, QUERY_BUDGET).status).toBe("ready");
    publishSource(env, "distinct native source body", "bound-origin", { evidence_object_id: root.object_id });
    expect(lexical(env).candidates).toEqual([]);
    expect(env.index.admitQueryCandidate(source, null, QUERY_BUDGET).status).toBe("stale");
    expect(env.index.writeLexical(source, documents[0]!.body, BUDGET).status).toBe("rejected");
  });

  it("indexes an independent capsule that cites an admitted source digest", async () => {
    const env = setup();
    const record = publishSource(env, "Harbor opening was put off.");
    const root = await new SqliteEvidenceCapsuleRepo(env.database).create({
      object_id: randomUUID(), object_kind: "evidence_capsule", schema_version: 1, lifecycle_state: "active",
      created_at: CLOCK, updated_at: CLOCK, created_by: "user_action", evidence_kind: "conversation_excerpt",
      semantic_anchor: { topic: "source", keywords: ["source"], summary: "retained source" },
      event_anchor: null, physical_anchor: null, evidence_health_state: "verified", gist: "independent gist",
      excerpt: "Harbor opening was put off.", source_hash: record.content_digest, run_id: "run-1",
      workspace_id: WORKSPACE, surface_id: null
    });
    const { generation, documents } = buildReady(env);
    expect(generation).toMatchObject({ enumeration_complete: true, target_count: 2 });
    expect(documents.map(row => row.source.target.root_kind).sort()).toEqual(["evidence_capsule", "source_record"]);
    expect(documents.some(row => row.source.source_id === record.source_id)).toBe(true);
    expect(documents.some(row => row.source.target.root_id === root.object_id)).toBe(true);
  });

  it.each(["source-first", "capsule-first"] as const)(
    "does not index a persisted provenance capsule (%s)", async order => {
      const env = setup();
      const body = "Harbor opening was put off.";
      const plantProvenance = (sourceHash: string | null = null) => new SqliteEvidenceCapsuleRepo(env.database).create({
        object_id: randomUUID(), object_kind: "evidence_capsule", schema_version: 1, lifecycle_state: "active",
        created_at: CLOCK, updated_at: CLOCK, created_by: "user_action", evidence_kind: "conversation_excerpt",
        semantic_anchor: { topic: "Proposed source interpretation", keywords: [], summary: "Unreviewed interpretation hypothesis" },
        event_anchor: null, physical_anchor: null, evidence_health_state: "questionable", gist: "provenance gist",
        excerpt: body, source_hash: sourceHash, run_id: "run-1", workspace_id: WORKSPACE, surface_id: null
      }, [], undefined, undefined, undefined, true);
      if (order === "source-first") {
        const record = publishSource(env, body);
        const first = buildReady(env);
        expect(first.documents).toHaveLength(1);
        await plantProvenance(record.content_digest);
        expect(env.index.generation(WORKSPACE, first.generation.generation_id)?.status).toBe("partial");
        const { generation, documents } = buildReady(env);
        expect(generation).toMatchObject({ enumeration_complete: true, target_count: 1 });
        expect(documents).toHaveLength(1);
        expect(documents[0]!.source).toMatchObject({ source_id: record.source_id, target: { root_kind: "source_record",
          root_id: record.record_id } });
        return;
      }
      await plantProvenance();
      const empty = env.index.begin(env.index.select(WORKSPACE, configuration()));
      expect(env.index.capturePage(WORKSPACE, empty.generation_id, 8, BUDGET).generation)
        .toMatchObject({ enumeration_complete: true, target_count: 0 });
      const record = publishSource(env, body);
      const { generation, documents } = buildReady(env);
      expect(generation).toMatchObject({ enumeration_complete: true, target_count: 1 });
      expect(documents).toHaveLength(1);
      expect(documents[0]!.source).toMatchObject({ source_id: record.source_id, target: { root_kind: "source_record",
        root_id: record.record_id } });
    });

  it("retains paid reads on native admission failure and rolls capture progress back", async () => {
    const env = setup(); await capsule(env); const { documents } = buildReady(env);
    env.index.unbind(WORKSPACE);
    const generation = env.index.begin(env.index.select(WORKSPACE, configuration()));
    env.database.connection.exec("DROP TABLE projection_erase_barriers");
    const query = env.index.admitQueryCandidate(documents[0]!.source, null, QUERY_BUDGET);
    expect(query).toMatchObject({ status: "partial", reason: "native_source_unavailable" });
    expect(query.resources.native_bytes).toBeGreaterThan(0);
    let failure: unknown;
    try { env.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SourceIndexOperationError);
    if (!(failure instanceof SourceIndexOperationError)) throw new Error("expected metered failure");
    expect(failure.resources.work).toBe(12); // empty record seek, capsule candidate, and guarded candidate/barrier attempt
    expect(failure.resources.native_bytes).toBeGreaterThan(0);
    expect(env.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ records_complete: false,
      after_capsule_cursor: null, enumeration_complete: false, target_count: 0 });
  });

  it("fences incompatible completed generations even if their old active pointer is restored", () => {
    const env = setup(); const { generation } = buildReady(env);
    env.database.connection.prepare("UPDATE source_index_generations SET preparation_revision=1 WHERE generation_id=?").run(generation.generation_id);
    expect(env.index.readVectorCandidates(WORKSPACE, null, 8, QUERY_BUDGET)).toMatchObject({
      completion: "unavailable", state: { status: "unavailable", reason: "incompatible_preparation_revision" } });
    expect(env.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "superseded" });
  });
});
