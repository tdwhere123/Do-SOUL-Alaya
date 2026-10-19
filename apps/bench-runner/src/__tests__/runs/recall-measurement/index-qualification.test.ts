import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { dirname, join } from "node:path";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { prepareSourceIndexDocument } from "@do-soul/alaya-protocol";
import { captureFrozenSourceIndexQualifications, frozenIndexMetadataMatchesNativeBinding,
  type FrozenSourceIndexQualificationPage } from "../../../runs/recall-measurement/index-qualification.js";
import { readSourceIndexRootQualification } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-index-measurement.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { INDEX_BUDGET, WS, ORIGINAL, QUERY_BUDGET, SIMULATED_CONFIGURATION, withIndexedSources, workerCall, type IndexFixture }
  from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-index-acquisition.test-support.js";

let nextSnapshot = 0;
function snapshotInput(fixture: IndexFixture) {
  const snapshotPath = join(dirname(fixture.filename), `qualification-${nextSnapshot++}.sqlite`);
  checkpointAndCopyBenchDb(fixture.filename, snapshotPath, { keepLiveConnection: true });
  return { snapshotPath, snapshotSha256: hashRegularFileNoFollow(snapshotPath), workspaceId: WS };
}
it("freezes actual indexed, not-indexed, partial-window and unbound SQLite facts without selecting an index", async () => {
  await withIndexedSources([{ id: "harbor", text: "Harbor was delayed.", vector: [1, 0, 0] },
    { id: "unindexed", text: "Not in the active index.", indexed: false }], async fixture => {
    const pages: FrozenSourceIndexQualificationPage[] = [];
    const capture = () => captureFrozenSourceIndexQualifications({ ...snapshotInput(fixture), onPage: page => { pages.push(page); } });
    const frozen = capture();
    expect(frozen).toMatchObject({ roots: 2, source_census: "complete", index: { query_state: { status: "partial" } } });
    expect(pages.every(page => page.snapshot_identity === frozen.snapshot_identity && page.index_identity === frozen.index_identity)).toBe(true);
    const verified = snapshotInput(fixture);
    expect(() => captureFrozenSourceIndexQualifications({ ...verified, snapshotSha256: "0".repeat(64), onPage: () => undefined }))
      .toThrow(/snapshot digest mismatch/);
    const indexed = pages.find(page => page.qualification.source_id === "harbor")!.qualification;
    expect(indexed).toMatchObject({ currentness: "ready", lexical: { status: "ready", start_byte: 0, end_byte: 19 },
      vector: { generation_member: true, expected_windows: 1, capture: "complete",
        windows: [expect.objectContaining({ status: "ready", start_byte: 0, end_byte: 19 })] } });
    expect(pages.find(page => page.qualification.source_id === "unindexed")!.qualification).toMatchObject({
      status: "not_indexed", lexical: { status: "not_indexed" }, vector: { generation_member: false, status: "not_indexed" } });
    const client = await fixture.openClient();
    const observed = await client.observeSourceSemantics({}, () => workerCall(client, {
      kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }));
    expect(frozenIndexMetadataMatchesNativeBinding(frozen, observed.observations[0]!.facts!.binding!.index)).toBe(true);
    expect(fixture.repository.generation(WS, fixture.generation.generation_id)!.status).toBe("partial");
    fixture.database.connection.prepare("DELETE FROM source_index_vectors WHERE workspace_id=?").run(WS);
    expect(() => captureFrozenSourceIndexQualifications({ snapshotPath: fixture.filename,
      snapshotSha256: hashRegularFileNoFollow(fixture.filename), workspaceId: WS, onPage: () => undefined }))
      .toThrow(/uncheckpointed source bytes/);
    pages.length = 0; capture();
    expect(pages.find(page => page.qualification.source_id === "harbor")!.qualification.vector).toMatchObject({
      status: "partial", windows: [expect.objectContaining({ status: "not_indexed", reason: "vector_missing" })] });
    fixture.repository.unbind(WS);
    pages.length = 0;
    const unbound = capture();
    expect(unbound.index).toMatchObject({ query_state: { status: "unbound", reason: "no_active_generation" },
      selection: { profile_id: fixture.selection.profile_id }, generation: null });
    const absent = fixture.database.connection.transaction(() => readSourceIndexRootQualification(
      fixture.database, fieldContractSha256, WS, "absent"))();
    expect(absent).toMatchObject({ status: "stale", currentness: "stale", reason: "missing_source" });
    expect(() => readSourceIndexRootQualification(fixture.database, fieldContractSha256, WS, "harbor")).toThrow(/frozen read transaction/);
  });
}, 60_000);

it("pages the authoritative stored manifest without treating a diagnostic window prefix as absent coverage", async () => {
  const text = "harbor ".repeat(40);
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    const selection = fixture.lifecycle.select(WS, { ...SIMULATED_CONFIGURATION, revision: "small-window-fixture",
      profile: { ...SIMULATED_CONFIGURATION.profile, window_bytes: 4 } });
    const generation = fixture.lifecycle.begin(selection);
    fixture.lifecycle.capture(WS, generation.generation_id, 128, INDEX_BUDGET);
    const target = fixture.repository.listTargets(WS, generation.generation_id, null, 128)[0]!;
    const document = prepareSourceIndexDocument({ source: target, body: text, profile: selection.configuration.profile }, fieldContractSha256);
    expect(fixture.repository.writeDocument(WS, generation.generation_id, document, INDEX_BUDGET).status).toBe("accepted");
    for (const window of document.windows) expect(fixture.repository.writeVector(WS, generation.generation_id, {
      window_id: window.window_id, input_digest: window.content_digest, embedding: new Float32Array([1, 0, 0]),
      token_count: 2, truncated: false }, INDEX_BUDGET).status).toBe("accepted");
    expect(fixture.lifecycle.publish(WS, generation.generation_id).status).toBe("accepted");
    const pages: FrozenSourceIndexQualificationPage[] = [];
    const captured = captureFrozenSourceIndexQualifications({ ...snapshotInput(fixture), onPage: page => { pages.push(page); } });
    expect(captured.source_census).toBe("complete");
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.qualification.vector.capture).toBe("partial");
    expect(pages.at(-1)!.qualification.vector.capture).toBe("complete");
    expect(pages.flatMap(page => page.qualification.vector.windows).map(window => window.window_id))
      .toEqual(document.windows.map(window => window.window_id));
    expect(pages.every(page => page.qualification.vector.windows.length <= 32)).toBe(true);
  });
}, 60_000);
