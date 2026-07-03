import { describe, expect, it, vi } from "vitest";
import { ReconciliationService } from "../../governance/reconciliation-service.js";
import { DecideFn, createDeps, createMemoryEntry, drive } from "./reconciliation-service.test-support.js";

describe("ReconciliationService projection metadata", () => {
  it("LLM UPDATE verdict carries projection fields into the survivor update", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center",
      domain_tags: ["stale-tag"],
      evidence_refs: ["evidence-old"]
    });
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "refines the residence fact"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(
      service,
      {
        incomingContent: "The user lives in Berlin since 2019",
        incomingDomainTags: ["residence", "fresh-tag"],
        incomingProjectionFields: {
          projection_schema_version: 1,
          event_time_start: "2019-01-01T00:00:00.000Z",
          time_precision: "year",
          time_source: "explicit"
        }
      },
      { evidenceRefForVerdict: () => "evidence-new" }
    );
    const decision = await driven.decision;

    expect(decision.kind).toBe("update");
    expect(decision.survivingObjectId).toBe("memory-neighbor");
    expect(driven.appliedVerdicts).toEqual(["update"]);
    expect(update).toHaveBeenCalledWith(
      "memory-neighbor",
      {
        content: "The user lives in Berlin since 2019",
        domain_tags: ["residence", "fresh-tag"],
        evidence_refs: ["evidence-old", "evidence-new"],
        projection_schema_version: 1,
        event_time_start: "2019-01-01T00:00:00.000Z",
        time_precision: "year",
        time_source: "explicit"
      },
      "reconciliation_refine"
    );
  });

  it("does not degrade UPDATE to ADD when the survivor update throws after decision", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin.",
      evidence_refs: ["evidence-old"]
    });
    const updatedNeighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin since 2019",
      domain_tags: ["residence"],
      evidence_refs: ["evidence-old", "evidence-mint-1"]
    });
    const findByIds = vi
      .fn()
      .mockResolvedValueOnce([neighbor])
      .mockResolvedValueOnce([updatedNeighbor]);
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryRepo: { findByIds }
    });
    update.mockRejectedValueOnce(new Error("event log append failed after repo update"));
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "refines the residence fact"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["residence"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("update");
    expect(driven.appliedVerdicts).toEqual(["update"]);
    expect(driven.evidenceMinted()).toBe(1);
  });

  it("degrades UPDATE to ADD when a thrown update did not mutate the survivor", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin.",
      evidence_refs: ["evidence-old"]
    });
    const findByIds = vi
      .fn()
      .mockResolvedValueOnce([neighbor])
      .mockResolvedValueOnce([neighbor])
      .mockResolvedValueOnce([neighbor]);
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryRepo: { findByIds }
    });
    update.mockRejectedValueOnce(new Error("repo update failed before mutation"));
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "refines the residence fact"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["residence"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(driven.appliedVerdicts).toEqual(["update", "add"]);
  });

  it("degrades UPDATE when reread tags duplicate one value and miss an intended tag", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin.",
      domain_tags: ["residence"],
      evidence_refs: ["evidence-old"]
    });
    const mismatchedNeighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin since 2019",
      domain_tags: ["residence", "residence"],
      evidence_refs: ["evidence-old", "evidence-mint-1"]
    });
    const findByIds = vi
      .fn()
      .mockResolvedValueOnce([neighbor])
      .mockResolvedValueOnce([neighbor])
      .mockResolvedValueOnce([mismatchedNeighbor]);
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryRepo: { findByIds }
    });
    update.mockRejectedValueOnce(new Error("repo update failed before intended tags landed"));
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "refines the residence fact"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["residence", "fresh-tag"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(driven.appliedVerdicts).toEqual(["update", "add"]);
  });

  it("keeps UPDATE when post-write projection clears reread as omitted fields", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lived in Berlin in 2019.",
      evidence_refs: ["evidence-old"],
      projection_schema_version: 1,
      event_time_start: "2019-01-01T00:00:00.000Z",
      time_precision: "year",
      time_source: "explicit"
    });
    const clearedNeighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin.",
      domain_tags: ["residence"],
      evidence_refs: ["evidence-old", "evidence-mint-1"]
    });
    const findByIds = vi
      .fn()
      .mockResolvedValueOnce([neighbor])
      .mockResolvedValueOnce([clearedNeighbor]);
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryRepo: { findByIds }
    });
    update.mockRejectedValueOnce(new Error("event append failed after null clear"));
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "removes stale date"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["residence"],
      incomingProjectionFields: {
        projection_schema_version: null,
        event_time_start: null,
        time_precision: null,
        time_source: null
      }
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("update");
    expect(driven.appliedVerdicts).toEqual(["update"]);
  });

  it("degrades UPDATE to ADD when survivor lookup fails before the write", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin.",
      evidence_refs: ["evidence-old"]
    });
    const findByIds = vi
      .fn()
      .mockRejectedValueOnce(new Error("lookup failed before update"));
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryRepo: { findByIds }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "refines the residence fact"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["residence"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(update).not.toHaveBeenCalled();
    expect(driven.appliedVerdicts).toEqual(["update", "add"]);
  });

  it("replaces stale projection metadata when UPDATE rewrites the memory content", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lived in Berlin in 2019.",
      evidence_refs: ["evidence-old"],
      projection_schema_version: 1,
      event_time_start: "2019-01-01T00:00:00.000Z",
      time_precision: "year",
      time_source: "explicit"
    });
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "updates the dated residence fact"
    }));
    const service = new ReconciliationService(deps);

    await drive(service, {
      incomingContent: "The user lived in Berlin in 2024.",
      incomingDomainTags: ["residence"],
      incomingProjectionFields: {
        projection_schema_version: 1,
        event_time_start: "2024-01-01T00:00:00.000Z",
        time_precision: "year",
        time_source: "explicit"
      }
    }).decision;

    expect(update.mock.calls[0][1]).toMatchObject({
      event_time_start: "2024-01-01T00:00:00.000Z",
      time_precision: "year",
      time_source: "explicit"
    });
  });

  it("NOOP merges missing projection metadata into the surviving row without evidence", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin.",
      evidence_refs: ["evidence-old"]
    });
    const { deps, update, append } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"],
      incomingProjectionFields: {
        projection_schema_version: 1,
        event_time_start: "2026-03-19T00:00:00.000Z",
        event_time_end: "2026-03-19T23:59:59.999Z",
        time_precision: "day",
        time_source: "explicit"
      }
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("noop");
    expect(driven.evidenceMinted()).toBe(0);
    expect(update).toHaveBeenCalledWith(
      "memory-neighbor",
      {
        projection_schema_version: 1,
        event_time_start: "2026-03-19T00:00:00.000Z",
        event_time_end: "2026-03-19T23:59:59.999Z",
        time_precision: "day",
        time_source: "explicit"
      },
      "reconciliation_projection_merge"
    );
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("keeps a NOOP duplicate drop when projection merge update fails", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin.",
      evidence_refs: ["evidence-old"]
    });
    const { deps, update, append } = createDeps([neighbor]);
    update.mockRejectedValueOnce(new Error("projection merge event append failed"));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"],
      incomingProjectionFields: {
        projection_schema_version: 1,
        event_time_start: "2026-03-19T00:00:00.000Z",
        time_precision: "day",
        time_source: "explicit"
      }
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("noop");
    expect(driven.appliedVerdicts).toEqual(["noop"]);
    expect(driven.evidenceMinted()).toBe(0);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("keeps a NOOP duplicate drop when projection merge lookup fails", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin.",
      evidence_refs: ["evidence-old"]
    });
    const findByIds = vi
      .fn()
      .mockRejectedValueOnce(new Error("projection merge lookup failed"));
    const { deps, update, append } = createDeps([neighbor], {
      memoryRepo: { findByIds }
    });
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"],
      incomingProjectionFields: {
        projection_schema_version: 1,
        event_time_start: "2026-03-19T00:00:00.000Z",
        time_precision: "day",
        time_source: "explicit"
      }
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("noop");
    expect(driven.appliedVerdicts).toEqual(["noop"]);
    expect(driven.evidenceMinted()).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
  });
});
