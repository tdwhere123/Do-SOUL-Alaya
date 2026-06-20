import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { ConflictDetectionService } from "../../governance/conflict-detection-service.js";
import type { PathMintOutcome } from "../../path-graph/path-relation-proposal-service.js";

import { createMemoryEntry } from "./conflict-detection-service.test-support.js";

describe("ConflictDetectionService", () => {
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
