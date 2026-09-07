import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteMemoryEntryRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { captureQuerySpec } from "../../../recall/decision/budget-aware-q/capture.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { createSliceHarness, MEM, CONTENT, NOW } from "./harness.js";

const databases = new Set<StorageDatabase>();
const paths: string[] = [];
afterEach(() => { for (const db of databases) db.close(); databases.clear(); for (const path of paths) rmSync(path, { recursive: true, force: true }); paths.length = 0; });
const harness = (filename?: string) => createSliceHarness((db) => databases.add(db), filename);

describe("repair boundary falsifiers", () => {
  it("rejects executable caller properties and custom array traversal", () => {
    expect(() => captureQuerySpec({ text: "x", get workspaceId() { return "foreign"; } }, fieldContractSha256, () => NOW)).toThrow(/accessors/);
    const obligations = Object.assign([], { map: () => [{ kind: "forged" }] });
    expect(() => captureQuerySpec({ text: "x", obligations }, fieldContractSha256, () => NOW)).toThrow(/array/);
  });
  it("rejects foreign principals, scopes, revoked sessions and cancellation", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus();
    for (const override of [{ workspaceId: "foreign" }, { principal: "foreign" }, { authorizedScopes: [] }, { authorizedScopes: ["foreign"] }]) {
      await expect(slice.runRecall({ text: "deployment checklist", ...override })).rejects.toThrow();
    }
    await expect(slice.runRecall({ text: "deployment checklist" }, AbortSignal.abort())).rejects.toThrow(/cancelled/);
    slice.revokeSession();
    await expect(slice.runRecall({ text: "deployment checklist" })).rejects.toThrow(/revoked/);
  });
  it("unrelated requested subject cannot receive a scoped owner claim", async () => {
    const slice = await harness(); await slice.plantLaunchCorpus();
    const result = await slice.runRecall({ text: "Who owns Lyra?" });
    expect(result.pack.claims).not.toContainEqual(expect.objectContaining({ kind: "observed_scoped_relation" }));
    const empty = await slice.runRecall({ text: "Who owns Orion?", k: 0 });
    expect(empty.pack.claims).not.toContainEqual(expect.objectContaining({ kind: "valid_time" }));
  });
  it("same metadata on disconnected endpoints cannot prove joint support", async () => {
    const slice = await harness(); await slice.plantLaunchCorpus();
    const result = await slice.runRecall({ text: "Orion owner and their escalation channel" });
    expect(result.pack.claims).not.toContainEqual({ kind: "joint_support" });
    expect(result.pack.claims).toContainEqual({ kind: "obligation_unsatisfied" });
  });
  it("query recognition supplies the actual endpoint join without caller obligations", async () => {
    const slice = await harness(); await slice.plantLaunchCorpus({ joinOwner: true });
    const result = await slice.runRecall({ text: "Orion owner and their escalation channel" });
    expect(result.pack.claims).toContainEqual({ kind: "joint_support" });
  });
  it("renamed subjects and endpoints derive joins from actual bindings", async () => {
    const slice = await harness();
    const owner = "50000000-0000-4000-8000-000000000001";
    const channel = "50000000-0000-4000-8000-000000000002";
    await slice.writeMemory(owner, "Vela owns Lyra", MemoryDimension.FACT, false);
    await slice.writeMemory(channel, "Vela uses relay for escalation", MemoryDimension.FACT, false);
    const validity = { kind: "open" as const, valid_from: "2025-01-01T00:00:00.000Z" };
    await slice.admitRelation({ evidenceId: "60000000-0000-4000-8000-000000000001", assertionId: "lyra-owner",
      sourceId: "lyra", targetId: "vela", resultObjectId: owner, relationKind: "owns", assignmentKey: "irrelevant-a", validity, gist: "Vela owns Lyra" });
    await slice.admitRelation({ evidenceId: "60000000-0000-4000-8000-000000000002", assertionId: "vela-channel",
      sourceId: "vela", targetId: "relay", resultObjectId: channel, relationKind: "escalation_channel", assignmentKey: "irrelevant-b", validity, gist: "Vela uses relay for escalation" });
    const result = await slice.runRecall({ text: "Lyra owner and their escalation channel" });
    expect(result.pack.claims).toContainEqual({ kind: "joint_support" });
    expect(result.membership).toEqual([owner, channel]);
  });

  it("lexical row capacity is independent from identity capacity and cap uncertainty is visible", async () => {
    const slice = await harness();
    await slice.writeMemory(MEM.checklist, "deployment checklist alpha", MemoryDimension.PROCEDURE, false);
    await slice.writeMemory(MEM.remote, "deployment checklist beta", MemoryDimension.PROCEDURE, false);
    const identityCut = await slice.runRecall({ text: "deployment checklist", nBase: 1, rBase: 10 });
    expect(identityCut.referenceInput.units).toHaveLength(1);
    expect(identityCut.counters.row_visits).toBeGreaterThanOrEqual(2);
    expect(identityCut.pack.truncated).toBe(true);
    const rowCut = await slice.runRecall({ text: "deployment checklist", nBase: 10, rBase: 1 });
    expect(rowCut.pack.truncated).toBe(true);
    expect(rowCut.pack.claims).toContainEqual({ kind: "truncated" });
  });

  it("an unrelated expired assertion cannot suppress an ordinary raw source", async () => {
    const slice = await harness();
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, false);
    await slice.admitRelation({ evidenceId: "60000000-0000-4000-8000-000000000003", assertionId: "expired-lyra",
      sourceId: "lyra", targetId: "vela", resultObjectId: MEM.checklist, relationKind: "owns", assignmentKey: "irrelevant",
      validity: { kind: "bounded", valid_from: "2025-01-01T00:00:00.000Z", valid_to: "2026-01-01T00:00:00.000Z" }, gist: "Vela once owned Lyra" });
    const result = await slice.runRecall({ text: "deployment checklist" });
    expect(result.membership).toContain(MEM.checklist);
  });

  it("assertion receipts require the public memory source's real evidence association", async () => {
    const slice = await harness(); await slice.plantLaunchCorpus();
    const source = await slice.memoryEntryRepo.findById(MEM.orion);
    expect(source?.evidence_refs.length).toBeGreaterThan(0);
    const positive = await slice.runRecall({ text: "Who owns Orion?" });
    expect(positive.pack.claims).toContainEqual(expect.objectContaining({ kind: "observed_scoped_relation" }));
    const lexical = await slice.runRecall({ text: "Orion", familyCaps: { typed_relation: "unavailable" } });
    const deliveredSource = lexical.pack.results.find((row) => row.object_id === MEM.orion);
    expect(deliveredSource).toBeDefined();
    expect(deliveredSource).toMatchObject({ source: { evidenceRefs: source!.evidence_refs } });
    expect(lexical.referenceInput.edges).toEqual([]);
    await slice.memoryService.updateScoped(MEM.orion, "workspace-1", { evidence_refs: [] }, "Remove source evidence association");
    expect((await slice.memoryEntryRepo.findById(MEM.orion))?.evidence_refs).toEqual([]);
    const unbound = await slice.runRecall({ text: "Who owns Orion?" });
    expect(unbound.pack.claims).not.toContainEqual(expect.objectContaining({ kind: "observed_scoped_relation" }));
    expect(unbound.referenceInput.edges).toEqual([]);
  });

  it("negated and compound temporal text does not mint certainty", async () => {
    const slice = await harness(); await slice.plantLaunchCorpus({ includeTemporalOwners: true });
    for (const text of ["Not before June 1, who owned Orion?", "Before January 1, 2020 and after June 1, who owned Orion?"]) {
      const result = await slice.runRecall({ text, asOf: "2026-06-15T00:00:00.000Z" });
      expect(result.pack.claims).toContainEqual({ kind: "unsupported_temporal_operator" });
      expect(result.pack.claims).not.toContainEqual(expect.objectContaining({ kind: "valid_time" }));
      expect(result.pack.claims).not.toContainEqual(expect.objectContaining({ kind: "observed_scoped_relation" }));
      expect(result.pack.claims).not.toContainEqual({ kind: "joint_support" });
    }
  });

  it("renamed subject and current-year before boundary use the dated observation", async () => {
    const slice = await harness();
    await slice.writeMemory(MEM.orion, "Dana owns Vega", MemoryDimension.FACT, false);
    await slice.admitRelation({ evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000008", assertionId: "assert-vega-dana",
      sourceId: "vega", targetId: "dana", resultObjectId: MEM.orion, relationKind: "owns", assignmentKey: "ignored",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, gist: "Dana owns Vega" });
    await slice.writeMemory(MEM.bob, "Evan owns Vega", MemoryDimension.FACT, false);
    await slice.admitRelation({ evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000009", assertionId: "assert-vega-evan",
      sourceId: "vega", targetId: "evan", resultObjectId: MEM.bob, relationKind: "owns", assignmentKey: "ignored",
      validity: { kind: "open", valid_from: "2026-06-01T00:00:00.0000Z" }, gist: "Evan owns Vega" });
    for (const asOf of ["2026-05-31T00:00:00.000Z", "2026-06-15T00:00:00.000Z"]) {
      const result = await slice.runRecall({ text: "Before June 1, who owned Vega?", asOf });
      expect(result.membership).toEqual([MEM.orion]);
      expect(result.pack.claims).toContainEqual(expect.objectContaining({ kind: "valid_time" }));
      expect(result.referenceInput.spec.relationQuery?.temporal).toEqual({ kind: "before", exclusiveEnd: "2026-06-01T00:00:00.000Z" });
    }
    for (const text of ["Who did not own Vega?", "Who didn't own Vega?", "Who didn’t own Vega?"]) {
      const negative = await slice.runRecall({ text });
      expect(negative.pack.claims).toContainEqual({ kind: "unsupported_relation_operator" });
      expect(negative.pack.claims).not.toContainEqual(expect.objectContaining({ kind: "observed_scoped_relation" }));
    }
  });

  it("mixed unknown validity stays ordinary evidence and scoped claims name only admitted support", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeTemporalOwners: true, includeChannel: false });
    await slice.writeMemory(MEM.charlie, "Charlie owned Orion; validity unknown", MemoryDimension.FACT, false);
    const result = await slice.runRecall({ text: "Before June 1, who owned Orion?", asOf: "2026-06-15T00:00:00.000Z" });
    expect(result.membership).toEqual(expect.arrayContaining([MEM.orion, MEM.charlie]));
    expect(result.membership).not.toContain(MEM.bob);
    const scoped = result.pack.claims.find((claim) => claim.kind === "valid_time");
    expect(scoped).toEqual({ kind: "valid_time", sourceObjectIds: [MEM.orion], evidenceRefs: ["bbbbbbbb-bbbb-4bbb-8bbb-000000000003"] });
    const unknownOnly = await harness();
    await unknownOnly.writeMemory(MEM.orion, "Alice owned Orion; validity unknown", MemoryDimension.FACT, false);
    const unknown = await unknownOnly.runRecall({ text: "Before June 1, who owned Orion?" });
    expect(unknown.membership).toContain(MEM.orion);
    expect(unknown.pack.claims.some((claim) => claim.kind === "valid_time")).toBe(false);
  });

  it("a real retraction of contradicted source support removes its active proof", async () => {
    const slice = await harness(); await slice.plantLaunchCorpus({ includeChannel: false });
    const before = await slice.runRecall({ text: "Who owns Orion?" });
    expect(before.referenceInput.edges.some((edge) => edge.assertionId === "assert-orion-alice")).toBe(true);
    await slice.relationService.resolve({ assertionId: "assert-orion-alice", workspaceId: "workspace-1", runId: "run-1",
      causedBy: "garden", resolutionKind: "retracted", reason: "The admitted source was contradicted by a reviewed follow-up",
      resolvedAt: "2026-05-30T12:00:00.0000Z" });
    const after = await slice.runRecall({ text: "Who owns Orion?" });
    expect(after.membership).not.toContain(MEM.orion);
    expect(after.referenceInput.edges).toEqual([]);
    expect(after.pack.claims.some((claim) => claim.kind === "valid_time" || claim.kind === "observed_scoped_relation")).toBe(false);
    expect((await slice.memoryEntryRepo.findById(MEM.orion))?.evidence_refs.length).toBeGreaterThan(0);
    const state = slice.database.connection.prepare("SELECT resolution_kind FROM relation_assertion_resolution_current WHERE assertion_id = ?")
      .get("assert-orion-alice");
    expect(state).toEqual({ resolution_kind: "retracted" });
  });

  it("bounds raw assertion/source reads before materializing twelve matching sources", async () => {
    const slice = await harness();
    for (let index = 1; index <= 12; index += 1) {
      const tail = String(index).padStart(12, "0");
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${tail}`;
      await slice.writeMemory(id, `Person${index} owns Vega`, MemoryDimension.FACT, false);
      await slice.admitRelation({ evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${tail}`, assertionId: `assert-vega-${index}`,
        sourceId: "vega", targetId: `person${index}`, resultObjectId: id, relationKind: "owns", assignmentKey: "unused",
        validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, gist: `Person${index} owns Vega` });
    }
    const byId = vi.spyOn(slice.memoryEntryRepo, "findById");
    for (const rBase of [1, 12]) {
      const result = await slice.runRecall({ text: "Who owns Vega?", rBase, nBase: 1, nExtension: 0 });
      expect(result.counters.row_visits).toBeLessThanOrEqual(rBase);
      expect(result.counters.source_reads).toBeLessThanOrEqual(rBase);
      expect(result.pack.truncated).toBe(true);
    }
    expect(byId).not.toHaveBeenCalled();
    expect(JSON.stringify(slice.recallReader.explain("workspace-1", "vega", "owns"))).toContain("idx_relation_recall_subject");
  });

  it("failed transactional enqueue rolls source, lexical projection and audit back before ack", async () => {
    const slice = await harness();
    const before = slice.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get();
    vi.spyOn(slice.garden, "enqueue").mockImplementation(() => { throw new Error("queue-full"); });
    await expect(slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true)).rejects.toThrow("queue-full");
    expect(await slice.memoryEntryRepo.findById(MEM.checklist)).toBeNull();
    expect(await slice.memoryEntryRepo.searchByKeyword("workspace-1", "deployment", 5)).toEqual([]);
    expect(slice.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toEqual(before);
    expect(slice.counters.write_ack_ms).toBe("not_observed");
  });
  it("committed source and pending job survive a real file database reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-repair-")); paths.push(directory);
    const filename = join(directory, "slice.sqlite");
    const slice = await harness(filename);
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    slice.database.close(); databases.delete(slice.database);
    const reopened = initDatabase({ filename }); databases.add(reopened);
    const row = await new SqliteMemoryEntryRepo(reopened).findById(MEM.checklist);
    expect(row?.content).toBe(CONTENT.checklist);
    expect(reopened.connection.prepare("SELECT COUNT(*) AS n FROM garden_tasks").get()).toMatchObject({ n: 1 });
  });
});

it("real contrary sources retain provenance under explicit contradicted governance",async()=>{
 const slice=await harness();
 await slice.writeMemory(MEM.orion,'Alice is the only owner of Orion',MemoryDimension.FACT,false);
 await slice.admitRelation({evidenceId:'bbbbbbbb-bbbb-4bbb-8bbb-000000000101',assertionId:'review-alice',sourceId:'orion',targetId:'alice',resultObjectId:MEM.orion,relationKind:'owns',assignmentKey:'unused',validity:{kind:'open',valid_from:'2025-01-01T00:00:00.000Z'},gist:'Alice is the only owner of Orion'});
 await slice.writeMemory(MEM.bob,'Bob is the only owner of Orion; the earlier Alice report was incorrect',MemoryDimension.FACT,false);
 await slice.admitRelation({evidenceId:'bbbbbbbb-bbbb-4bbb-8bbb-000000000102',assertionId:'review-bob',sourceId:'orion',targetId:'bob',resultObjectId:MEM.bob,relationKind:'owns',assignmentKey:'unused',validity:{kind:'open',valid_from:'2025-01-01T00:00:00.000Z'},gist:'Bob is the only owner of Orion; the earlier Alice report was incorrect'});
 await slice.relationService.resolve({assertionId:'review-alice',workspaceId:'workspace-1',runId:'run-1',causedBy:'garden',resolutionKind:'contradicted',reason:'The separately admitted Bob source contradicts the Alice report',resolvedAt:'2026-05-30T12:00:00.000Z'});
 const result=await slice.runRecall({text:'Who owns Orion?',k:5});

 expect(result.membership).toEqual(expect.arrayContaining([MEM.orion,MEM.bob]));
 expect(result.pack.claims.some(x=>x.kind==='conflict_distinct_lineages')).toBe(true);
 expect(result.referenceInput.edges.some(x=>x.assertionId==='review-alice')).toBe(false);
 expect(result.pack.claims.find(x=>x.kind==='valid_time')).toEqual({kind:'valid_time',sourceObjectIds:[MEM.bob],evidenceRefs:['bbbbbbbb-bbbb-4bbb-8bbb-000000000102']});
 expect(result.pack.results.find(x=>x.object_id===MEM.orion)?.source?.evidenceRefs).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-000000000101']);
 expect(result.pack.claims.find(x=>x.kind==='conflict_distinct_lineages')).toEqual({kind:'conflict_distinct_lineages',activeSourceObjectIds:[MEM.bob],contradicted:[{assertionId:'review-alice',sourceObjectId:MEM.orion,evidenceRefs:['bbbbbbbb-bbbb-4bbb-8bbb-000000000101'],resolvedAt:'2026-05-30T12:00:00.000Z'}]});
});

it("an unrelated append with an equal entity revision revokes the captured query", async () => {
  const slice = await harness(); await slice.plantLaunchCorpus({ includeChannel: false });
  const read = slice.recallReader.read.bind(slice.recallReader);
  let pending: Promise<unknown> | undefined;
  vi.spyOn(slice.recallReader, "read").mockImplementationOnce((...args) => {
    const result = read(...args);
    pending = slice.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000099", "Unrelated new source", MemoryDimension.FACT, false);
    return result;
  });
  const recall = slice.runRecall({ text: "Who owns Orion?" });
  await expect(recall).rejects.toThrow(/stale/);
  await pending;
});

it("common source admission excludes active lifecycle rows retained as tombstones", async () => {
  const slice = await harness(); await slice.plantLaunchCorpus({ includeChannel: false });
  slice.database.connection.prepare("UPDATE memory_entries SET retention_state = 'tombstoned' WHERE object_id = ?").run(MEM.orion);
  const result = await slice.runRecall({ text: "Who owns Orion?" });
  expect(result.membership).not.toContain(MEM.orion);
  expect(result.referenceInput.edges).toEqual([]);
});
