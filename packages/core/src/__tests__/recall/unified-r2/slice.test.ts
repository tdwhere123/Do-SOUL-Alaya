import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { referenceSelect } from "../offline/reference.js";
import { emitPackets } from "../../../recall/decision/budget-aware-q/field.js";
import type { QuerySpecDraft } from "../../../recall/decision/budget-aware-q/types.js";
import { createSliceHarness, JOIN_OBLIGATION } from "./harness.js";
import { CONTENT, MEM } from "./ids.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function harness() {
  return createSliceHarness((database) => databases.add(database));
}

describe("real local vertical recall", () => {
  it("L5 text boundary overrides request as-of against real dated sources", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeTemporalOwners: true, includeChannel: false });
    const before = await slice.runRecall({ text: "Before June 1, who owned Orion?", asOf: "2026-06-15T00:00:00.000Z" });
    expect(before.membership).toEqual([MEM.orion]);
    expect(before.membership).not.toContain(MEM.bob);
    expect(before.pack.claims).toContainEqual(expect.objectContaining({ kind: "valid_time" }));
    const early = await slice.runRecall({ text: "Before January 1, 2020, who owned Orion?", asOf: "2026-06-15T00:00:00.000Z" });
    expect(early.membership).not.toContain(MEM.orion);
    expect(early.membership).not.toContain(MEM.bob);
    expect(early.pack.claims).not.toContainEqual(expect.objectContaining({ kind: "valid_time" }));
  });
  it("Q1 lexical checklist is useful with zero remote extract", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus();
    const result = await slice.runRecall({
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.membership).toContain(MEM.checklist);
    expect(result.pack.results[0]?.object_id).toBe(MEM.checklist);
    expect(result.counters.recall_provider_calls).toBe(0);
    expect(result.counters.write_provider_calls).toBe(0);
    expect(result.counters.selection_count).toBe(1);
    expect(result.pack.claims.some((claim) => claim.kind === "heuristic_evidence")).toBe(true);
  });

  // The required model positive is exercised separately by local-model.test.ts.

  it("requested embedding readiness cannot certify a planted constant vector", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ plantVectors: true });
    const result = await slice.runRecall({ text: "volcano eruption calendar", familyCaps: { embedding: "ready" } });
    expect(result.counters.query_embed_count).toBe(0);
    expect(result.membership).not.toContain(MEM.remote);
    expect(result.pack.claims).toContainEqual({ kind: "capability_unavailable", capability: "embedding" });
  });

  it("Q1c embedding-unavailable stays on the same algorithm and does not hang", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ plantVectors: false });
    const result = await slice.runRecall({
      text: "Who is working remotely?",
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.counters.query_embed_count).toBe(0);
    expect(result.pack.claims.some((claim) =>
      claim.kind === "capability_unavailable" && claim.capability === "embedding"
    )).toBe(true);
    expect(result.selectionCount).toBe(1);
  });

  it("Q3 grounded two-object packet when both edges exist", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeChannel: true, joinOwner: true });
    const result = await slice.runRecall({
      text: "Orion owner and their escalation channel",
      obligations: [JOIN_OBLIGATION],
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.membership).toEqual(expect.arrayContaining([MEM.orion, MEM.channel]));
    expect(result.pack.claims.some((claim) => claim.kind === "joint_support")).toBe(true);
    const packets = emitPackets(
      { packetM: 64, widthW: 4, obligations: [JOIN_OBLIGATION] },
      result.membership,
      result.referenceInput.edges
    );
    expect(packets.some((packet) => packet.unitIds.length === 2)).toBe(true);
  });

  it("Q3n does not emit a pair when the channel edge is missing", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeChannel: false });
    const result = await slice.runRecall({
      text: "Orion owner and their escalation channel",
      obligations: [JOIN_OBLIGATION],
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.pack.claims.some((claim) => claim.kind === "obligation_unsatisfied")).toBe(true);
    const packets = emitPackets(
      { packetM: 64, widthW: 4, obligations: [JOIN_OBLIGATION] },
      [MEM.orion, MEM.channel],
      result.referenceInput.edges
    );
    expect(packets.some((packet) => packet.unitIds.length === 2)).toBe(false);
  });

  it("explicit as-of returns Alice not Bob without claiming to parse temporal text", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeTemporalOwners: true, includeChannel: false });
    const result = await slice.runRecall({
      text: "Who owned Orion?",
      asOf: "2026-05-31T12:00:00.000Z",
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.membership).toContain(MEM.orion);
    expect(result.membership).not.toContain(MEM.bob);
    expect(result.pack.claims.some((claim) => claim.kind === "valid_time")).toBe(true);
  });

  it("L5n after the bound returns Bob not Alice", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeTemporalOwners: true, includeChannel: false });
    const result = await slice.runRecall({
      text: "Who owned Orion?",
      asOf: "2026-06-15T00:00:00.000Z",
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.membership).toContain(MEM.bob);
    expect(result.membership).not.toContain(MEM.orion);
  });

  it("L6 lists observed owners without claiming completeness", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeCharlie: true, includeChannel: false });
    const result = await slice.runRecall({
      text: "List observed owners of Orion",
      k: 5,
      enumeration: true,
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.membership).toEqual(expect.arrayContaining([MEM.orion, MEM.charlie]));
    expect(result.pack.claims.some((claim) => claim.kind === "enumeration_observed_not_all")).toBe(true);
    expect(result.pack.claims).not.toContainEqual({ kind: "conflict_distinct_lineages" });
  });

  it("L7 unsupported exact aggregate returns evidence and no fabricated count", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeCharlie: true, includeChannel: false });
    const result = await slice.runRecall({
      text: "How many owners ever?",
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.membership.length).toBeGreaterThan(0);
    expect(result.pack.claims.some((claim) => claim.kind === "unsupported_exact_aggregate")).toBe(true);
    expect(JSON.stringify(result.pack)).not.toMatch(/"count"\s*:/);
  });

  it("H1 diagnostics on/off share one QuerySpec and one selection", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus();
    const draft: QuerySpecDraft = {
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" }
    };
    const off = await slice.runRecall({ ...draft, diagnostics: false });
    const on = await slice.runRecall({ ...draft, diagnostics: true });
    expect(off.querySpecDigest).toBe(on.querySpecDigest);
    expect(off.selectionCount).toBe(1);
    expect(on.selectionCount).toBe(1);
    expect(off.membership).toEqual(on.membership);
  });

  it("rejects delivery_path legacy at the TARGET entry", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus();
    const result = await slice.runRecall({
      text: "Where is the deployment checklist?",
      deliveryPath: "legacy",
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.membership).toEqual([]);
    expect(result.pack.claims.some((claim) =>
      claim.kind === "unsupported_mode" && claim.mode === "legacy"
    )).toBe(true);
  });

  it("reference and slice agree on the checklist membership", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus();
    const result = await slice.runRecall({
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" }
    });
    const reference = referenceSelect(result.referenceInput);
    expect(reference.membership).toEqual(result.membership);
  });
});

describe("launch plants", () => {
  it("keeps checklist gist as planted source text", () => {
    expect(CONTENT.checklist).toContain("deployment checklist");
  });
});
