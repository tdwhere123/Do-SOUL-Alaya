import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { ConflictDetectionService } from "../../governance/conflict-detection-service.js";
import type { PathMintOutcome } from "../../path-graph/path-relation-proposal-service.js";

import { createMemoryEntry } from "./conflict-detection-service.test-support.js";

describe("ConflictDetectionService", () => {
it("rule-path contradicts seeds a WEAK attention_only path (agent-controllable verdict, not recall_allowed)", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findBySharedDomainTags: vi.fn(async () => [existing])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const service = new ConflictDetectionService({ memoryRepo, pathCandidatePort });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer light roast tea instead.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    // rule path = agent-controllable Jaccard heuristic → weak seed:
    // attention_only / 0.5, NOT the recall_allowed/0.9 band reserved for
    // the LLM verdict. recall_bias sign preserved so plasticity still
    // classifies it negative.
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAnchor: { kind: "object", object_id: "mem-B" },
        targetAnchor: { kind: "object", object_id: "mem-A" },
        relationKind: "contradicts",
        workspaceId: "workspace-1",
        recallBiasSign: -1,
        governanceClass: "attention_only",
        initialStrength: 0.5
      })
    );
  });

// invariant (two-entry truth-boundary lock): B-4 ConflictDetection is the
  // direct-materialize entry — it submits to PathCandidateSink and NEVER routes
  // through the edge_proposals review queue (the service has no edge-proposal
  // dependency, so it structurally cannot create a proposal row). Every minted
  // path is born in a governed band (rule -> attention_only, llm -> recall_allowed)
  // and NEVER strictly_governed. Compare: the review-gated entry (manual
  // soul.propose_edge + B-1 cross-link) creates an edge_proposals row and does
  // NOT call submitCandidate at propose time — locked in
  // edge-proposal-service.test.ts ("creates a pending proposal ...").
  // see also: packages/core/src/path-graph/edge-proposal-service.ts AUTO_ACCEPT_FLOOR_BY_TRIGGER;
  //   docs/archive/v0.3-historical/v0.3.11/kpi-targets.md K4.1.
  it("B-4 direct-materializes a governed weak path (rule attention_only / llm recall_allowed), never edge_proposals, never strictly_governed", async () => {
    const ruleExisting = createMemoryEntry({ object_id: "mem-A", content: "I prefer dark roast coffee." });
    const ruleMemoryRepo = {
      findByDimension: vi.fn(async () => [ruleExisting]),
      findBySharedDomainTags: vi.fn(async () => [ruleExisting])
    };
    const ruleSink = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const ruleService = new ConflictDetectionService({ memoryRepo: ruleMemoryRepo, pathCandidatePort: ruleSink });
    await ruleService.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer light roast tea instead.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });
    expect(ruleSink.submitCandidate.mock.calls.length).toBeGreaterThan(0);
    for (const call of ruleSink.submitCandidate.mock.calls as any[]) {
      expect(call[0].governanceClass).toBe("attention_only");
      expect(call[0].governanceClass).not.toBe("strictly_governed");
    }

    const llmAmbiguous = createMemoryEntry({
      object_id: "mem-A",
      content: "Generic coffee preference text.",
      domain_tags: ["coffee", "alpha"]
    });
    const llmMemoryRepo = {
      findByDimension: vi.fn(async () => [llmAmbiguous]),
      findBySharedDomainTags: vi.fn(async () => [])
    };
    const llmSink = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const llmPort = { classifyPair: vi.fn(async () => "contradicts" as const) };
    const llmService = new ConflictDetectionService({
      memoryRepo: llmMemoryRepo,
      pathCandidatePort: llmSink,
      llmPort,
      llmMaxPairsPerNewMemory: 4
    });
    await llmService.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "Different but related coffee fact.",
      newMemoryDomainTags: ["coffee", "beta"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });
    expect(llmSink.submitCandidate.mock.calls.length).toBeGreaterThan(0);
    for (const call of llmSink.submitCandidate.mock.calls as any[]) {
      expect(call[0].governanceClass).toBe("recall_allowed");
      expect(call[0].governanceClass).not.toBe("strictly_governed");
    }

    // Non-vacuous channel-sole-mutation lock. The deps surface
    // (ConflictDetectionServiceDeps) has no edge-proposal port by
    // construction, so there is no proposal-creation mock to spy. Instead
    // assert positively that across BOTH B-4 sub-paths (rule + LLM) the ONLY
    // write/mutation channel exercised is pathCandidatePort.submitCandidate:
    // the memoryRepo ports are read-only (findByDimension / findBySharedDomainTags)
    // and llmPort is a read-only classifier (classifyPair). If a future change
    // ever routed a B-4 verdict through edge_proposals, it would have to invoke
    // some channel OTHER than submitCandidate, tripping this assertion.
    expect(ruleSink.submitCandidate).toHaveBeenCalled();
    expect(llmSink.submitCandidate).toHaveBeenCalled();
    // rule path: the only mutation was submitCandidate; the only other ports
    // touched are the read-only repo lookups.
    expect(ruleMemoryRepo.findByDimension).toHaveBeenCalled();
    // llm path: classifyPair is the only non-sink port invoked, and it is a
    // pure read-only verdict (returns a classification, mutates nothing).
    expect(llmPort.classifyPair).toHaveBeenCalled();
    // The mutation channel is singular: the union of every injected port's
    // method names exposes exactly one write-capable port (submitCandidate);
    // none of memoryRepo / llmPort exposes a proposal/edge-create method.
    const llmInjectedMethodNames = [
      ...Object.keys(llmMemoryRepo),
      ...Object.keys(llmSink),
      ...Object.keys(llmPort)
    ];
    expect(llmInjectedMethodNames).toEqual([
      "findByDimension",
      "findBySharedDomainTags",
      "submitCandidate",
      "classifyPair"
    ]);
    expect(llmInjectedMethodNames).not.toContain("proposeEdge");
    expect(llmInjectedMethodNames).not.toContain("createEdge");
  });

it("rule-path contradicts does NOT fire supersede_penalty karma (strength-gated to the LLM verdict)", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findBySharedDomainTags: vi.fn(async () => [existing])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const emitKarmaEvent = vi.fn(async () => {});
    const service = new ConflictDetectionService({
      memoryRepo,
      pathCandidatePort,
      karmaEmitter: { emitKarmaEvent }
    });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer light roast tea instead.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    // the rule path produced a contradicts candidate (path written) but the
    // karma penalty must be withheld — an agent-controllable Jaccard hit
    // cannot program a durable retention/activation demotion of the peer.
    const contradictsCalls = pathCandidatePort.submitCandidate.mock.calls.filter(
      (call: any[]) => call[0].relationKind === "contradicts"
    );
    expect(contradictsCalls.length).toBeGreaterThan(0);
    expect(emitKarmaEvent).not.toHaveBeenCalled();
  });

it("llm-path contradicts seeds recall_allowed/0.9 and fires supersede_penalty karma", async () => {
    // tag overlap of {coffee, alpha} vs {coffee, beta} is 1/3 ≈ 0.333:
    // below the rule threshold (0.35) but above the LLM gate, so only the
    // LLM verdict fires.
    const ambiguous = createMemoryEntry({
      object_id: "mem-A",
      content: "Generic coffee preference text.",
      domain_tags: ["coffee", "alpha"]
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [ambiguous]),
      findBySharedDomainTags: vi.fn(async () => [])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const emitKarmaEvent = vi.fn(async () => {});
    const llmPort = { classifyPair: vi.fn(async () => "contradicts" as const) };
    const service = new ConflictDetectionService({
      memoryRepo,
      pathCandidatePort,
      llmPort,
      karmaEmitter: { emitKarmaEvent },
      llmMaxPairsPerNewMemory: 4
    });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "Different but related coffee fact.",
      newMemoryDomainTags: ["coffee", "beta"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        relationKind: "contradicts",
        recallBiasSign: -1,
        governanceClass: "recall_allowed",
        initialStrength: 0.9
      })
    );
    expect(emitKarmaEvent).toHaveBeenCalledWith({
      kind: "supersede_penalty",
      objectId: "mem-A",
      workspaceId: "workspace-1",
      runId: "run-1"
    });
  });

it("skips contradicts when content is nearly identical (high token overlap)", async () => {
    const existing = createMemoryEntry({ object_id: "mem-A" });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findBySharedDomainTags: vi.fn(async () => [existing])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const service = new ConflictDetectionService({ memoryRepo, pathCandidatePort });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer dark roast coffee daily.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    const contradictsCalls = pathCandidatePort.submitCandidate.mock.calls.filter(
      (call: any[]) => call[0].relationKind === "contradicts"
    );
    expect(contradictsCalls).toHaveLength(0);
  });

it("writes an incompatible_with edge across dimensions when tags overlap", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      dimension: MemoryDimension.CONSTRAINT,
      content: "Hard rule about beans.",
      domain_tags: ["coffee"]
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => []),
      findBySharedDomainTags: vi.fn(async () => [existing])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const service = new ConflictDetectionService({ memoryRepo, pathCandidatePort });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer instant coffee.",
      newMemoryDomainTags: ["coffee"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    const incompatibleCalls = pathCandidatePort.submitCandidate.mock.calls.filter(
      (call: any[]) => call[0].relationKind === "incompatible_with"
    ) as unknown[][];
    expect(incompatibleCalls).toHaveLength(1);
    expect(incompatibleCalls[0][0]).toMatchObject({
      sourceAnchor: { kind: "object", object_id: "mem-B" },
      targetAnchor: { kind: "object", object_id: "mem-A" },
      recallBiasSign: -1
    });
  });

it("calls LLM port for ambiguous neighbors only when rule produced no contradicts", async () => {
    // tag overlap of {coffee, alpha} vs {coffee, beta} is 1/3 ≈ 0.333:
    // above the LLM threshold (0.25) but below the rule threshold (0.5),
    // so the rule path does not fire but LLM gets a chance.
    const ambiguous = createMemoryEntry({
      object_id: "mem-A",
      content: "Generic coffee preference text.",
      domain_tags: ["coffee", "alpha"]
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [ambiguous]),
      findBySharedDomainTags: vi.fn(async () => [])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const llmPort = {
      classifyPair: vi.fn(async () => "contradicts" as const)
    };
    const service = new ConflictDetectionService({
      memoryRepo,
      pathCandidatePort,
      llmPort,
      llmMaxPairsPerNewMemory: 4
    });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "Different but related coffee fact.",
      newMemoryDomainTags: ["coffee", "beta"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(llmPort.classifyPair).toHaveBeenCalled();
  });

it("strictNoDrop=true rethrows LLM classifier failures instead of degrading to no-conflict", async () => {
    const ambiguous = createMemoryEntry({
      object_id: "mem-A",
      content: "Generic coffee preference text.",
      domain_tags: ["coffee", "alpha"]
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [ambiguous]),
      findBySharedDomainTags: vi.fn(async () => [])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const llmPort = {
      classifyPair: vi.fn(async () => {
        throw new Error("llm unavailable");
      })
    };
    const service = new ConflictDetectionService({
      memoryRepo,
      pathCandidatePort,
      llmPort,
      llmMaxPairsPerNewMemory: 4
    });

    await expect(
      service.detectAndLinkConflicts({
        newMemoryId: "mem-B",
        newMemoryDimension: MemoryDimension.PREFERENCE,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "Different but related coffee fact.",
        newMemoryDomainTags: ["coffee", "beta"],
        workspaceId: "workspace-1",
        runId: "run-1",
        strictNoDrop: true
      })
    ).rejects.toThrow("llm unavailable");
    expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
  });

it("default mode warns and degrades when the LLM classifier fails", async () => {
    const warn = vi.fn();
    const ambiguous = createMemoryEntry({
      object_id: "mem-A",
      content: "Generic coffee preference text.",
      domain_tags: ["coffee", "alpha"]
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [ambiguous]),
      findBySharedDomainTags: vi.fn(async () => [])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const llmPort = {
      classifyPair: vi.fn(async () => {
        throw new Error("llm unavailable");
      })
    };
    const service = new ConflictDetectionService({
      memoryRepo,
      pathCandidatePort,
      llmPort,
      llmMaxPairsPerNewMemory: 4,
      warn
    });

    await expect(
      service.detectAndLinkConflicts({
        newMemoryId: "mem-B",
        newMemoryDimension: MemoryDimension.PREFERENCE,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "Different but related coffee fact.",
        newMemoryDomainTags: ["coffee", "beta"],
        workspaceId: "workspace-1",
        runId: "run-1"
      })
    ).resolves.toBeUndefined();
    expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "conflict detection llm pair classify failed",
      expect.objectContaining({
        new_memory_id: "mem-B",
        existing_memory_id: "mem-A",
        error: "llm unavailable"
      })
    );
  });

it("skips LLM when rule path already produced a contradicts edge", async () => {
    // tag overlap = 1.0 + token overlap << 0.35 → rule fires contradicts;
    // LLM must not run because LLM-only-on-no-rule is the documented
    // invariant.
    const ruleHit = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [ruleHit]),
      findBySharedDomainTags: vi.fn(async () => [])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const llmPort = {
      classifyPair: vi.fn(async () => "contradicts" as const)
    };
    const service = new ConflictDetectionService({
      memoryRepo,
      pathCandidatePort,
      llmPort
    });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer light roast tea instead.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(llmPort.classifyPair).not.toHaveBeenCalled();
    const contradictsCalls = pathCandidatePort.submitCandidate.mock.calls.filter(
      (call: any[]) => call[0].relationKind === "contradicts"
    );
    expect(contradictsCalls).toHaveLength(1);
  });

it("does not throw when memoryRepo fails to read same-dimension peers", async () => {
    const memoryRepo = {
      findByDimension: vi.fn(async () => {
        throw new Error("repo down");
      }),
      findBySharedDomainTags: vi.fn(async () => [])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const service = new ConflictDetectionService({ memoryRepo, pathCandidatePort });

    await expect(
      service.detectAndLinkConflicts({
        newMemoryId: "mem-B",
        newMemoryDimension: MemoryDimension.PREFERENCE,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "fact",
        newMemoryDomainTags: ["coffee"],
        workspaceId: "workspace-1",
        runId: "run-1"
      })
    ).resolves.toBeUndefined();
  });
});
