import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { referenceSelect } from "../offline/reference.js";
import { emitPackets } from "../../../recall/decision/budget-aware-q/field.js";
import type { QuerySpecDraft } from "../../../recall/decision/budget-aware-q/types.js";
import { createSliceHarness, JOIN_OBLIGATION } from "./harness.js";
import { CONTENT, MEM, NOW } from "./ids.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function harness() {
  return createSliceHarness((database) => databases.add(database));
}

describe("C02 real local vertical slice", () => {
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

  it("Q1b planted vectors retrieve the paraphrase target without a provider", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ plantVectors: true });
    const result = await slice.runRecall({
      text: "Who is working remotely?",
      familyCaps: { embedding: "ready" }
    });
    expect(result.membership).toContain(MEM.remote);
    expect(result.counters.query_embed_count).toBeLessThanOrEqual(1);
    expect(result.counters.query_embed_count).toBeGreaterThan(0);
    expect(result.counters.recall_provider_calls).toBe(0);
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
    await slice.plantLaunchCorpus({ includeChannel: true });
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
      slice.typedEdges(NOW)
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
      slice.typedEdges(NOW)
    );
    expect(packets.some((packet) => packet.unitIds.length === 2)).toBe(false);
  });

  it("L5 valid-time returns Alice not Bob", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeTemporalOwners: true, includeChannel: false });
    const result = await slice.runRecall({
      text: "Before June 1, who owned Orion?",
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
    const units = result.pack.results.map((row, index) => ({
      id: row.object_id,
      content: row.content,
      framedBytes: Buffer.byteLength(`${row.object_id}\n${row.content}\n`, "utf8"),
      chargedTokens: Buffer.byteLength(`${row.object_id}\n${row.content}\n`, "utf8"),
      familyRanks: { lexical: index + 1 },
      answerBindings: [],
      assignmentKey: null
    }));
    const reference = referenceSelect({
      spec: {
        text: "Where is the deployment checklist?",
        principal: "agent",
        workspaceId: "workspace-1",
        authorizedScopes: ["workspace-1"],
        asOf: NOW,
        k: 5,
        tokenBudget: 2000,
        nBase: 64,
        nExtension: 64,
        rBase: 512,
        rExtension: 512,
        packetM: 64,
        widthW: 4,
        workLimit: 2 * 5 * 64,
        envelopeBytes: 64,
        enumeration: false,
        exactAggregate: false,
        diagnostics: false,
        deliveryPath: null,
        obligations: [],
        familyCaps: { lexical: "ready", typed_relation: "ready", embedding: "unavailable" }
      },
      units,
      edges: [],
      packets: units.map((unit) => ({ id: `singleton:${unit.id}`, unitIds: [unit.id] }))
    });
    expect(reference.membership).toEqual(result.membership);
  });
});

describe("C02 launch plants", () => {
  it("keeps checklist gist as planted source text", () => {
    expect(CONTENT.checklist).toContain("deployment checklist");
  });
});
