import { afterEach, describe, expect, it } from "vitest";
import type { SourceIndexVectorBinding, SourceIndexVectorRead } from "@do-soul/alaya-protocol";
import {
  BUDGET, QUERY_BUDGET, WORKSPACE, expectQueryResources, fixture, targetFor, vectorWindowIds, type Fixture
} from "./source-index-query-fixture.js";
import {
  buildReady, configuration, eraseSource, publishSource, vectorFor
} from "./source-index-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  for (const environment of environments.splice(0)) environment.database.close();
});
function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}
function requireBinding(read: SourceIndexVectorRead): SourceIndexVectorBinding {
  if (!("binding" in read.state)) throw new Error(`expected vector binding: ${read.state.reason}`);
  return read.state.binding;
}

describe("source index query currentness after native mutation", () => {
  it("keeps an activated same-profile generation readable as partial for an unchanged root", () => {
    const environment = setup();
    const kept = publishSource(environment, "kept current body", "kept");
    publishSource(environment, "other indexed body", "other");
    const ready = buildReady(environment);
    const keptSource = ready.documents.find(document => document.source.target.root_id === kept.record_id)!.source;
    publishSource(environment, "unrelated native mutation", "unrelated");
    expect(environment.index.state(WORKSPACE)).toMatchObject({
      status: "partial", active_generation_id: ready.generation.generation_id
    });
    const scan = environment.index.readVectorCandidates(WORKSPACE, null, 128, QUERY_BUDGET);
    expectQueryResources(scan.resources);
    expect(scan.state).toMatchObject({ status: "partial" });
    expect(requireBinding(scan).generation_id).toBe(ready.generation.generation_id);
    expect(scan.candidates.some(candidate => candidate.source.root_key === keptSource.root_key)).toBe(true);
    const admitted = environment.index.admitQueryCandidate(keptSource, requireBinding(scan), QUERY_BUDGET);
    expectQueryResources(admitted.resources);
    expect(admitted).toMatchObject({ status: "ready", scope_class: null });
  });

  it("refuses a changed or erased root and still rejects epoch-lagged build writes", () => {
    const environment = setup();
    const original = publishSource(environment, "original indexed body", "mutable");
    const ready = buildReady(environment);
    const document = ready.documents.find(value => value.source.target.root_id === original.record_id)!;
    const scan = environment.index.readVectorCandidates(WORKSPACE, null, 8, QUERY_BUDGET);
    const binding = requireBinding(scan);
    const replacement = publishSource(environment, "replacement current body", "mutable", {
      source_version: "v2", recorded_at: "2026-09-22T00:00:00Z"
    });
    expect(environment.records.findCurrent(WORKSPACE, original.source_id)?.record_id).toBe(replacement.record_id);
    const changed = environment.index.admitQueryCandidate(document.source, binding, QUERY_BUDGET);
    expect(changed).toMatchObject({ status: "stale", reason: "source_changed" });
    expectQueryResources(changed.resources);
    expect(environment.index.writeDocument(WORKSPACE, ready.generation.generation_id, document, BUDGET))
      .toEqual({ status: "rejected", reason: "stale", resources: { work: 0, native_bytes: 0 } });
    expect(environment.index.writeVector(WORKSPACE, ready.generation.generation_id, vectorFor(document.windows[0]!)))
      .toEqual({ status: "rejected", reason: "stale" });
    expect(environment.index.activate(WORKSPACE, ready.generation.generation_id))
      .toEqual({ status: "rejected", reason: "stale" });
    const survivor = publishSource(environment, "erase target body", "erase-me");
    const second = buildReady(environment, configuration({ model_revision: "v2" }));
    const erasedSource = second.documents.find(value => value.source.target.root_id === survivor.record_id)!.source;
    const secondScan = environment.index.readVectorCandidates(WORKSPACE, null, 8, QUERY_BUDGET);
    eraseSource(environment, survivor.record_id);
    expect(environment.erase.isErased(WORKSPACE, survivor.record_id)).toBe(true);
    const erased = environment.index.admitQueryCandidate(erasedSource, requireBinding(secondScan), QUERY_BUDGET);
    expect(erased.status).not.toBe("ready");
    expect(erased).toMatchObject({ status: "stale", reason: "native_source_unavailable" });
    expect(environment.records.findById(WORKSPACE, survivor.record_id)?.source_body).toBeNull();
  });

  it("cannot read retired history after selection, model, or null active-pointer changes", () => {
    const environment = setup();
    publishSource(environment, "first generation body");
    const first = buildReady(environment);
    const firstScan = environment.index.readVectorCandidates(WORKSPACE, null, 1, QUERY_BUDGET);
    const firstCursor = firstScan.cursor;
    expect(firstCursor).not.toBeNull();
    const firstBinding = requireBinding(firstScan);
    environment.index.select(WORKSPACE, configuration({ model_revision: "v2" }));
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "unbound", active_generation_id: null });
    const afterSelect = environment.index.readVectorCandidates(WORKSPACE, firstCursor, 8, QUERY_BUDGET);
    expect(afterSelect).toMatchObject({ completion: "unavailable", reason: "no_active_generation", candidates: [] });
    expect(afterSelect.state).toEqual({ status: "unbound", reason: "no_active_generation" });
    publishSource(environment, "second generation body", "source-b");
    const second = buildReady(environment, configuration({ model_revision: "v2" }));
    expect(second.generation.generation_id).not.toBe(first.generation.generation_id);
    const switched = environment.index.readVectorCandidates(WORKSPACE, firstCursor, 8, QUERY_BUDGET);
    expect(switched).toMatchObject({ completion: "unavailable", reason: "active_generation_changed", candidates: [] });
    const live = environment.index.readVectorCandidates(WORKSPACE, null, 128, QUERY_BUDGET);
    expect(requireBinding(live).generation_id).toBe(second.generation.generation_id);
    expect(live.candidates.map(candidate => candidate.window.window_id))
      .toEqual(vectorWindowIds(environment.database, WORKSPACE, second.generation.generation_id));
    const retired = vectorWindowIds(environment.database, WORKSPACE, first.generation.generation_id);
    expect(retired.length).toBeGreaterThan(0);
    expect(live.candidates.every(candidate => !retired.includes(candidate.window.window_id))).toBe(true);
    const liveCursor = live.cursor;
    environment.index.fail(WORKSPACE, second.generation.generation_id, "interrupted");
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
    expect(environment.index.readVectorCandidates(WORKSPACE, liveCursor, 8, QUERY_BUDGET))
      .toMatchObject({ completion: "unavailable", reason: "no_active_generation" });
    expect(environment.index.admitQueryCandidate(second.documents[0]!.source, firstBinding, QUERY_BUDGET))
      .toMatchObject({ status: "unbound", reason: "no_active_generation" });
  });

  it("keeps a missing canonical dependency unknown rather than source absence", () => {
    const environment = setup();
    const origin = publishSource(environment, "retained origin", "origin", {
      source_representation: { kind: "retained_excerpt" }
    });
    const projection = publishSource(environment, "User retained origin", "projection", {
      source_representation: { kind: "canonical_projection", source_record_ids: [origin.record_id] }
    });
    const ready = buildReady(environment);
    const source = ready.documents.find(document => document.source.target.root_id === projection.record_id)!.source;
    const binding = requireBinding(environment.index.readVectorCandidates(WORKSPACE, null, 8, QUERY_BUDGET));
    expect(environment.database.connection.prepare("DELETE FROM source_records WHERE workspace_id=? AND record_id=?")
      .run(WORKSPACE, origin.record_id).changes).toBe(1);
    expect(environment.records.findById(WORKSPACE, projection.record_id)?.source_body).toBeNull();
    const admitted = environment.index.admitQueryCandidate(source, binding, QUERY_BUDGET);
    expectQueryResources(admitted.resources);
    expect(admitted.status).not.toBe("ready");
    expect(admitted).toMatchObject({ status: "stale", reason: "native_source_unavailable" });
    expect(admitted).not.toMatchObject({ reason: "missing_source" });
    expect(environment.index.admitQueryCandidate(source, null, QUERY_BUDGET))
      .toMatchObject({ status: "stale", reason: "native_source_unavailable" });
  });

  it("returns the current native scope class and gold tuple through the query guard", () => {
    const environment = setup();
    const project = publishSource(environment, "project scoped body", "project-source", { scope_class: "project" });
    const core = publishSource(environment, "global core body", "core-source", { scope_class: "global_core" });
    const ready = buildReady(environment);
    const projectSource = ready.documents.find(document => document.source.target.root_id === project.record_id)!.source;
    const coreSource = ready.documents.find(document => document.source.target.root_id === core.record_id)!.source;
    expect(environment.index.admitQueryCandidate(projectSource, null, QUERY_BUDGET))
      .toMatchObject({ status: "ready", scope_class: "project" });
    expect(environment.index.admitQueryCandidate(coreSource, null, QUERY_BUDGET))
      .toMatchObject({ status: "ready", scope_class: "global_core" });
    expect(environment.database.connection.prepare(
      "UPDATE source_records SET scope_class='global_domain' WHERE workspace_id=? AND record_id=?"
    ).run(WORKSPACE, project.record_id).changes).toBe(1);
    expect(environment.records.findCurrent(WORKSPACE, project.source_id)?.scope_class).toBe("global_domain");
    const current = environment.index.admitQueryCandidate(projectSource, null, QUERY_BUDGET);
    expect(current).toMatchObject({ status: "ready", scope_class: "global_domain" });
    expect(targetFor(environment.records.findCurrent(WORKSPACE, project.source_id)!).root_key).toBe(projectSource.root_key);
    const forged = { ...projectSource, root_key: `${projectSource.root_key}-forged` };
    expect(environment.index.admitQueryCandidate(forged, null, QUERY_BUDGET))
      .toMatchObject({ status: "stale", reason: "target_identity" });
  });
});
