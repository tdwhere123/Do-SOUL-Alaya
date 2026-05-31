import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { ConflictDetectionService } from "../conflict-detection-service.js";
import type { PathMintOutcome } from "../path-relation-proposal-service.js";

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const base: MemoryEntry = {
    object_id: overrides.object_id ?? "memory-existing",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-16T00:00:00.000Z",
    updated_at: "2026-05-16T00:00:00.000Z",
    created_by: "test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "I prefer dark roast coffee.",
    domain_tags: ["coffee", "preference"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.6,
    retention_score: 0.6,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
  return { ...base, ...overrides };
}

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

  it("ruleEnabled=false skips rule-path edges so only the LLM port produces contradicts", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findBySharedDomainTags: vi.fn(async () => [existing])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const llmPort = {
      classifyPair: vi.fn(async () => "contradicts" as const)
    };
    const service = new ConflictDetectionService({
      memoryRepo,
      pathCandidatePort,
      llmPort,
      ruleEnabled: false
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

    expect(llmPort.classifyPair).toHaveBeenCalled();
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAnchor: { kind: "object", object_id: "mem-B" },
        targetAnchor: { kind: "object", object_id: "mem-A" },
        relationKind: "contradicts",
        recallBiasSign: -1
      })
    );
  });

  it("rule path fires in the 0.35..0.5 tag overlap wedge (v0.3.11 §C C3)", async () => {
    // {coffee, beans, prep} vs {coffee, beans, dark, light}: jaccard
    // = |∩|/|∪| = 2/5 = 0.40. Above the v0.3.11 floor (0.35) and below
    // the pre-v0.3.11 floor (0.50) — i.e. the exact wedge §C C3 opens.
    // Pre-v0.3.11 this contradicts would have been silently dropped.
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee.",
      domain_tags: ["coffee", "beans", "dark", "light"]
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
      newMemoryContent: "I prefer light roast tea.",
      newMemoryDomainTags: ["coffee", "beans", "prep"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    const contradictsCalls = pathCandidatePort.submitCandidate.mock.calls.filter(
      (call: any[]) => call[0].relationKind === "contradicts"
    );
    expect(contradictsCalls).toHaveLength(1);
  });

  it("shared-tag candidate narrowing yields the SAME INCOMPATIBLE_WITH edges as a full-workspace scan", async () => {
    // Recall-equivalence proof. The INCOMPATIBLE_WITH gate keeps a peer
    // only when jaccard(domain_tags) >= 0.35 AND (dim or scope mismatch).
    // jaccard >= 0.35 implies >=1 shared tag, so the shared-tag set is a
    // strict superset of every gate-passing peer. The fixture spans the
    // four discriminating cases:
    //   (a) cross-dimension, shares >=0.35 tags  -> MUST be linked
    //   (b) cross-dimension, shares 1 tag <0.35  -> NOT linked (gate fails)
    //   (c) cross-dimension, ZERO shared tags    -> NOT even a candidate
    //   (d) same-dimension + same-scope          -> not an INCOMPATIBLE peer
    const newMemoryDomainTags = ["coffee", "beans", "prep"];

    // (a) jaccard({coffee,beans,prep},{coffee,beans}) = 2/3 ~= 0.67 >= 0.35
    const crossDimSharesEnough = createMemoryEntry({
      object_id: "mem-a",
      dimension: MemoryDimension.CONSTRAINT,
      content: "Hard rule about beans and coffee.",
      domain_tags: ["coffee", "beans"]
    });
    // (b) jaccard({coffee,beans,prep},{coffee,x,y,z}) = 1/6 ~= 0.167 < 0.35
    const crossDimShares1TagBelowGate = createMemoryEntry({
      object_id: "mem-b",
      dimension: MemoryDimension.CONSTRAINT,
      content: "Unrelated rule mentioning coffee once.",
      domain_tags: ["coffee", "x", "y", "z"]
    });
    // (c) zero shared tags -- the storage query would never return it.
    const crossDimZeroShared = createMemoryEntry({
      object_id: "mem-c",
      dimension: MemoryDimension.CONSTRAINT,
      content: "Totally unrelated rule.",
      domain_tags: ["tea", "kettle"]
    });
    // (d) same dimension + same scope: excluded by the !dimMismatch &&
    // !scopeMismatch guard regardless of tag overlap.
    const sameDimSameScope = createMemoryEntry({
      object_id: "mem-d",
      dimension: MemoryDimension.PREFERENCE,
      scope_class: ScopeClass.PROJECT,
      content: "A same-dimension coffee preference.",
      domain_tags: ["coffee", "beans"]
    });

    const fullWorkspace = [
      crossDimSharesEnough,
      crossDimShares1TagBelowGate,
      crossDimZeroShared,
      sameDimSameScope
    ];

    // Reference: what the OLD full-scan gate would link. Replays the exact
    // gate predicate the service applies over every workspace memory.
    const newTagSet = new Set(newMemoryDomainTags);
    const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
      if (a.size === 0 && b.size === 0) {
        return 0;
      }
      let intersection = 0;
      for (const v of a) {
        if (b.has(v)) {
          intersection += 1;
        }
      }
      const union = a.size + b.size - intersection;
      return union === 0 ? 0 : intersection / union;
    };
    const fullScanExpectedTargets = fullWorkspace
      .filter((m) => {
        const dimMismatch = m.dimension !== MemoryDimension.PREFERENCE;
        const scopeMismatch = m.scope_class !== ScopeClass.PROJECT;
        if (!dimMismatch && !scopeMismatch) {
          return false;
        }
        return jaccard(newTagSet, new Set(m.domain_tags)) >= 0.35;
      })
      .map((m) => m.object_id)
      .sort();
    // sanity: only (a) survives the full-scan gate.
    expect(fullScanExpectedTargets).toEqual(["mem-a"]);

    // The shared-tag query faithfully returns only memories sharing >=1 of
    // the new memory's tags -- (a),(b),(d) share, (c) does not, so (c) is
    // never handed to the service as a candidate.
    const findBySharedDomainTags = vi.fn(async (_workspaceId: string, tags: readonly string[]) => {
      const queryTagSet = new Set(tags);
      return fullWorkspace.filter((m) => m.domain_tags.some((t) => queryTagSet.has(t)));
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => []),
      findBySharedDomainTags
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const service = new ConflictDetectionService({ memoryRepo, pathCandidatePort });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-new",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer instant coffee with fewer beans.",
      newMemoryDomainTags: newMemoryDomainTags,
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    // (c) the zero-shared-tag memory was never fetched as a candidate:
    // the query was asked only for the new memory's tags, and mem-c shares
    // none, so it cannot appear in any result row.
    const queriedTags = findBySharedDomainTags.mock.calls.map((call) => call[1]);
    expect(queriedTags).toEqual([newMemoryDomainTags]);

    const incompatibleTargets = pathCandidatePort.submitCandidate.mock.calls
      .filter((call: any[]) => call[0].relationKind === "incompatible_with")
      .map((call: any[]) => call[0].targetAnchor.object_id)
      .sort();

    // The narrowed-candidate edges equal the full-scan edges exactly.
    expect(incompatibleTargets).toEqual(fullScanExpectedTargets);
    expect(incompatibleTargets).toEqual(["mem-a"]);
  });

  it("ruleEnabled=false with no llmPort produces no edges", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findBySharedDomainTags: vi.fn(async () => [existing])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const service = new ConflictDetectionService({
      memoryRepo,
      pathCandidatePort,
      ruleEnabled: false
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

    expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
  });

  // invariant (codex spine-review B5): strict no-drop mode must surface a
  // candidate-query failure as a throw so the bulk-enrich worker releases the
  // claim and a later cycle retries — it must NOT degrade to an empty candidate
  // set that silently drops every owed conflict edge for this memory.
  it("strictNoDrop=true rethrows a candidate-query failure (no degrade-to-empty)", async () => {
    const memoryRepo = {
      findByDimension: vi.fn(async () => {
        throw new Error("findByDimension db error");
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
        newMemoryContent: "I prefer light roast tea instead.",
        newMemoryDomainTags: ["coffee", "preference"],
        workspaceId: "workspace-1",
        runId: "run-1",
        strictNoDrop: true
      })
    ).rejects.toThrow("findByDimension db error");
    expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
  });

  // invariant (codex spine-review B5): strict no-drop mode must surface a
  // transient path-mint "failed" as an OBLIGATION_VIOLATION throw so the owed
  // path is retried, never markProcessed away.
  it("strictNoDrop=true throws OBLIGATION_VIOLATION when submitCandidate returns a transient failed", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findBySharedDomainTags: vi.fn(async () => [existing])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "failed") };
    const service = new ConflictDetectionService({ memoryRepo, pathCandidatePort });

    await expect(
      service.detectAndLinkConflicts({
        newMemoryId: "mem-B",
        newMemoryDimension: MemoryDimension.PREFERENCE,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "I prefer light roast tea instead.",
        newMemoryDomainTags: ["coffee", "preference"],
        workspaceId: "workspace-1",
        runId: "run-1",
        strictNoDrop: true
      })
    ).rejects.toMatchObject({ name: "CoreError", code: "OBLIGATION_VIOLATION" });
  });

  // invariant: best-effort inline mode (the default) preserves the prior
  // contract — a candidate-query failure must NOT break a successful memory
  // creation, so it degrades to an empty candidate set and warns rather than
  // throwing. Only the bulk-enrich worker opts into strictNoDrop.
  it("default (best-effort) mode warns and degrades on a candidate-query failure (no throw)", async () => {
    const warn = vi.fn();
    const memoryRepo = {
      findByDimension: vi.fn(async () => {
        throw new Error("findByDimension db error");
      }),
      findBySharedDomainTags: vi.fn(async () => [])
    };
    const pathCandidatePort = { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied") };
    const service = new ConflictDetectionService({ memoryRepo, pathCandidatePort, warn });

    await expect(
      service.detectAndLinkConflicts({
        newMemoryId: "mem-B",
        newMemoryDimension: MemoryDimension.PREFERENCE,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "I prefer light roast tea instead.",
        newMemoryDomainTags: ["coffee", "preference"],
        workspaceId: "workspace-1",
        runId: "run-1"
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "memoryRepo.findByDimension failed",
      expect.objectContaining({ workspace_id: "workspace-1" })
    );
  });
});
