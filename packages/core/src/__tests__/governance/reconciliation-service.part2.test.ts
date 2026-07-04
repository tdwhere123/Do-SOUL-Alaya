import { describe, expect, it, vi } from "vitest";
import { type MemoryEntry } from "@do-soul/alaya-protocol";
import { ReconciliationService, createRuleOnlyReconciliationDecisionPort, type ReconciliationServiceDependencies, type ReconciliationVerdictApplier } from "../../governance/reconciliation/reconciliation-service.js";

import { DecideFn, UpdateFn, baseInput, createDeps, createMemoryEntry, drive } from "./reconciliation-service.test-support.js";

describe("ReconciliationService", () => {
it("degrades to ADD when pre-write recall throws", async () => {
    const { deps } = createDeps([], {
      preWriteRecall: {
        recall: async () => {
          throw new Error("fts unavailable");
        }
      }
    });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("add");
  });

it("serializes concurrent reconciles for the same workspace", async () => {
    let active = 0;
    let maxActive = 0;
    const neighbor = createMemoryEntry({ content: "unrelated content here" });
    const { deps } = createDeps([neighbor], {
      preWriteRecall: {
        recall: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { candidates: [], uncertainty: 1, auditFeatures: { candidate_count: 0 } };
        }
      }
    });
    const service = new ReconciliationService(deps);

    await Promise.all([
      drive(service, { incomingContent: "fact one", incomingDomainTags: [] }).decision,
      drive(service, { incomingContent: "fact two", incomingDomainTags: [] }).decision,
      drive(service, { incomingContent: "fact three", incomingDomainTags: [] }).decision
    ]);

    // The keyed mutex must keep at most one critical section running per
    // workspace key — the decide -> create window stays closed.
    expect(maxActive).toBe(1);
  });
});

describe("ReconciliationService storage-level lease", () => {
  it("acquires and releases the lease around a normal decide->write pass", async () => {
    const { deps } = createDeps([]);
    const acquireCalls: string[] = [];
    const releaseCalls: string[] = [];
    const lease = {
      tryAcquire: (leaseKey: string, ownerToken: string) => {
        acquireCalls.push(`${leaseKey}:${ownerToken}`);
        return { owner_token: ownerToken };
      },
      release: (leaseKey: string, ownerToken: string) => {
        releaseCalls.push(`${leaseKey}:${ownerToken}`);
      }
    };
    const service = new ReconciliationService({ ...deps, lease });

    const driven = drive(service, {
      incomingContent: "The user prefers tabs over spaces.",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(acquireCalls).toHaveLength(1);
    // The lease is released after the pass, by the same owner token.
    expect(releaseCalls).toEqual(acquireCalls);
  });

  it("degrades to ADD with a conflict scan when the lease is held by another process", async () => {
    // A neighbor that would normally NOOP — proving the lease-busy path
    // short-circuits BEFORE the decision so it never reaches the gate.
    const neighbor = createMemoryEntry({ content: "The user lives in Berlin." });
    const { deps, decide, preWriteRecall } = createDeps([neighbor]);
    const lease = {
      tryAcquire: () => null,
      release: vi.fn()
    };
    const service = new ReconciliationService({ ...deps, lease });

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
    expect(driven.appliedVerdicts).toEqual(["add"]);
    // The decide path was never entered — no retrieval, no LLM judge.
    expect(preWriteRecall).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    // A lease that was never acquired is never released.
    expect(lease.release).not.toHaveBeenCalled();
  });

  it("releases the lease even when the decide->write pass throws", async () => {
    const { deps } = createDeps([]);
    const releaseCalls: string[] = [];
    const lease = {
      tryAcquire: (_leaseKey: string, ownerToken: string) => ({ owner_token: ownerToken }),
      release: (leaseKey: string, ownerToken: string) => {
        releaseCalls.push(`${leaseKey}:${ownerToken}`);
      }
    };
    const service = new ReconciliationService({ ...deps, lease });

    const applyVerdict: ReconciliationVerdictApplier = async () => {
      throw new Error("synthetic applyVerdict failure");
    };

    await expect(
      service.runWithDecision(
        { ...baseInput, incomingContent: "a brand new fact", incomingDomainTags: [] },
        applyVerdict
      )
    ).rejects.toThrow("synthetic applyVerdict failure");
    // The finally block releases the lease so a crash cannot wedge ingest.
    expect(releaseCalls).toHaveLength(1);
  });
});

// invariant: the rule-only, zero-cloud decision basis. Reconciliation
// must dedup out of the box without any cloud/LLM call: the identity
// NOOP and the below-floor ADD are decided before the port is consulted,
// and the ambiguous band resolves conservatively to ADD (never a
// rule-based UPDATE/NOOP — that needs the semantic-judge upgrade). These
// tests wire the real rule-only port behind a spy whose `decide` does no
// network I/O, so any spy invocation is the ambiguous-band path and the
// absence of a real garden-LLM call is asserted by construction.
// see also: packages/core/src/governance/reconciliation-service.ts
//   createRuleOnlyReconciliationDecisionPort
describe("ReconciliationService rule-only (zero-cloud) basis", () => {
  function createRuleOnlyDeps(
    neighbors: readonly MemoryEntry[],
    overrides: Partial<ReconciliationServiceDependencies> = {}
  ): {
    readonly deps: ReconciliationServiceDependencies;
    readonly ruleOnlyDecide: ReturnType<typeof vi.fn<DecideFn>>;
  } {
    const base = createDeps(neighbors, overrides);
    // Wrap the REAL rule-only port in a spy: the spy proves whether the
    // ambiguous band consulted the port at all, while the wrapped real
    // implementation proves the verdict is ADD with no network.
    const realPort = createRuleOnlyReconciliationDecisionPort();
    const ruleOnlyDecide = vi.fn<DecideFn>(realPort.decide);
    const deps: ReconciliationServiceDependencies = {
      ...base.deps,
      llmDecision: { decide: ruleOnlyDecide },
      ...overrides
    };
    return { deps, ruleOnlyDecide };
  }

  it("dedup: a normalized-string-identical fact NOOPs with zero port (and zero network) call", async () => {
    const neighbor = createMemoryEntry({ content: "The user lives in Berlin." });
    const { deps, ruleOnlyDecide } = createRuleOnlyDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "  The user lives in   Berlin.  ",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    // Dedup must work rule-only: the identity NOOP is decided before the
    // port is ever consulted.
    expect(decision.kind).toBe("noop");
    expect(decision.survivingObjectId).toBe("memory-existing");
    expect(driven.appliedVerdicts).toEqual(["noop"]);
    expect(driven.evidenceMinted()).toBe(0);
    expect(ruleOnlyDecide).not.toHaveBeenCalled();
  });

  it("ADD: a novel fact below the floor appends with zero port call", async () => {
    const neighbor = createMemoryEntry({
      content: "The user owns three cats.",
      domain_tags: ["pets"]
    });
    const { deps, ruleOnlyDecide } = createRuleOnlyDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user works as a marine biologist.",
      incomingDomainTags: ["career"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(driven.appliedVerdicts).toEqual(["add"]);
    expect(ruleOnlyDecide).not.toHaveBeenCalled();
  });

  it("ambiguous band: a non-identical above-floor neighbor resolves to ADD, never a rule-based UPDATE/NOOP", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const update = vi.fn<UpdateFn>(async (objectId) => createMemoryEntry({ object_id: objectId }));
    const { deps, ruleOnlyDecide } = createRuleOnlyDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryUpdate: { update }
    });
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    // The ambiguous band consulted the rule-only port — and it resolved
    // to ADD. No rule-based UPDATE (no in-place rewrite) and no NOOP drop.
    expect(ruleOnlyDecide).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("add");
    expect(driven.appliedVerdicts).toEqual(["add"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("the rule-only port resolves ADD for any candidate set and performs no I/O", async () => {
    const port = createRuleOnlyReconciliationDecisionPort();
    const verdict = await port.decide({
      incomingContent: "The user lives in Berlin since 2019",
      candidates: [{ objectId: "memory-neighbor", content: "The user lives in Berlin city center" }]
    });
    expect(verdict.kind).toBe("add");
    expect(verdict.targetObjectId).toBeUndefined();
  });

  it("the per-workspace mutex still serializes concurrent reconciles in rule-only mode", async () => {
    let active = 0;
    let maxActive = 0;
    const neighbor = createMemoryEntry({ content: "unrelated content here" });
    const { deps } = createRuleOnlyDeps([neighbor], {
      preWriteRecall: {
        recall: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { candidates: [], uncertainty: 1, auditFeatures: { candidate_count: 0 } };
        }
      }
    });
    const service = new ReconciliationService(deps);

    await Promise.all([
      drive(service, { incomingContent: "fact one", incomingDomainTags: [] }).decision,
      drive(service, { incomingContent: "fact two", incomingDomainTags: [] }).decision,
      drive(service, { incomingContent: "fact three", incomingDomainTags: [] }).decision
    ]);

    expect(maxActive).toBe(1);
  });

  it("the storage-level lease still guards the decide->write section in rule-only mode", async () => {
    const neighbor = createMemoryEntry({ content: "The user lives in Berlin." });
    const { deps, ruleOnlyDecide } = createRuleOnlyDeps([neighbor]);
    const lease = {
      tryAcquire: () => null,
      release: vi.fn()
    };
    const service = new ReconciliationService({ ...deps, lease });

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    // Lease busy short-circuits to ADD before the decide path — the
    // both-ADD race guard is load-bearing in rule-only mode too.
    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
    expect(ruleOnlyDecide).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });
});
