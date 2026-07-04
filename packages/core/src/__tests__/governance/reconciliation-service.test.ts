import { describe, expect, it, vi } from "vitest";
import { type MemoryEntry } from "@do-soul/alaya-protocol";
import { PreWriteRecallService } from "../../governance/reconciliation/pre-write-recall-service.js";
import { ReconciliationService } from "../../governance/reconciliation/reconciliation-service.js";

import { DecideFn, createDeps, createMemoryEntry, drive } from "./reconciliation-service.test-support.js";

describe("ReconciliationService", () => {
  it("ADD: appends a genuinely new fact when no similar memory exists", async () => {
    const { deps, update, decide } = createDeps([]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user works as a marine biologist.",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(driven.appliedVerdicts).toEqual(["add"]);
    expect(driven.evidenceMinted()).toBe(1);
  });

  it("ADD: empty incoming content returns early without retrieval", async () => {
    const { deps, preWriteRecall } = createDeps([createMemoryEntry()]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "   ",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("add");
    expect(preWriteRecall).not.toHaveBeenCalled();
  });

  it("ADD: a neighbor below the similarity floor never reaches the LLM", async () => {
    const neighbor = createMemoryEntry({
      content: "The user owns three cats.",
      domain_tags: ["pets"]
    });
    const { deps, decide } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user works as a marine biologist.",
      incomingDomainTags: ["career"]
    }).decision;

    expect(decision.kind).toBe("add");
    expect(decide).not.toHaveBeenCalled();
  });

  it("pre-write recall: structural candidates reach the LLM even when lexical overlap is low", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-redis",
      content: "Redis deployment credentials rotate monthly.",
      canonical_entities: ["redis"],
      domain_tags: ["ops"]
    });
    const decide = vi.fn<DecideFn>(async () => ({ kind: "add", reason: "distinct" }));
    const preWriteRecall = new PreWriteRecallService({
      lexicalSearch: { searchByKeyword: async () => [] },
      memoryRepo: {
        findByIds: async (_workspaceId, objectIds) =>
          [neighbor].filter((entry) => objectIds.includes(entry.object_id)),
        findByWorkspaceId: async () => [neighbor]
      },
      limit: 8
    });
    const { deps } = createDeps([], {
      preWriteRecall,
      llmDecision: { decide }
    });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "数据库密码每月轮换。",
      incomingDomainTags: ["ops"],
      incomingProjectionFields: { canonical_entities: ["redis"] }
    }).decision;

    expect(decision.kind).toBe("add");
    expect(decide).toHaveBeenCalledWith({
      incomingContent: "数据库密码每月轮换。",
      candidates: [{ objectId: "memory-redis", content: "Redis deployment credentials rotate monthly." }]
    });
  });

  it("pre-write recall: typed slot candidates survive noisy domain-tag neighbors", async () => {
    const tagNeighbors = Array.from({ length: 8 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-tag-${index}`,
        content: `Ops note ${index}`,
        domain_tags: ["ops"]
      })
    );
    const typedNeighbor = createMemoryEntry({
      object_id: "memory-slot",
      content: "The user prefers Postgres for analytics.",
      domain_tags: [],
      preference_subject: "user",
      preference_predicate: "prefers",
      preference_object: "postgres"
    });
    const allNeighbors = [...tagNeighbors, typedNeighbor];
    const decide = vi.fn<DecideFn>(async () => ({ kind: "add", reason: "distinct" }));
    const preWriteRecall = new PreWriteRecallService({
      lexicalSearch: {
        searchByKeyword: async (_workspaceId, queryText) =>
          queryText === "user" || queryText === "prefers" ? [{ object_id: "memory-slot" }] : []
      },
      memoryRepo: {
        findByIds: async (_workspaceId, objectIds) =>
          allNeighbors.filter((entry) => objectIds.includes(entry.object_id)),
        findByWorkspaceId: async () => tagNeighbors
      },
      limit: 8
    });
    const { deps } = createDeps([], {
      preWriteRecall,
      llmDecision: { decide }
    });
    const service = new ReconciliationService(deps);

    await drive(service, {
      incomingContent: "The user prefers mysql for analytics.",
      incomingDomainTags: ["ops"],
      incomingProjectionFields: {
        preference_subject: "user",
        preference_predicate: "prefers",
        preference_object: "mysql"
      }
    }).decision;

    expect(decide.mock.calls[0]?.[0].candidates).toContainEqual({
      objectId: "memory-slot",
      content: "The user prefers Postgres for analytics."
    });
  });

  it("NOOP: a normalized-string-identical duplicate collapses with zero LLM call and creates nothing", async () => {
    const neighbor = createMemoryEntry({
      content: "The user lives in Berlin.",
      evidence_refs: ["evidence-old"]
    });
    const { deps, update, decide, append } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "  The user lives in   Berlin.  ",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("noop");
    expect(decision.survivingObjectId).toBe("memory-existing");
    // NOOP creates nothing: no evidence_capsule minted, no memory write.
    expect(driven.appliedVerdicts).toEqual(["noop"]);
    expect(driven.evidenceMinted()).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0].event_type).toBe("soul.signal.triaged");
    expect(append.mock.calls[0][0].entity_id).toBe("signal-1:noop_audit");
    expect(append.mock.calls[0][0].caused_by).toBe("reconciliation_noop");
    expect(append.mock.calls[0][0].payload_json).toMatchObject({
      triage_result: "dropped",
      dropped_content: "The user lives in   Berlin.",
      surviving_object_id: "memory-existing"
    });
  });

	it("rejects a runId from another workspace before NOOP audit append", async () => {
	    const neighbor = createMemoryEntry({
	      content: "The user lives in Berlin.",
	      evidence_refs: ["evidence-old"]
	    });
	    const { deps, append } = createDeps([neighbor], {
	      runLookup: {
	        getById: async (runId) =>
	          runId === "run-foreign" ? { workspace_id: "workspace-other" } : { workspace_id: "workspace-1" }
	      }
	    });
	    const service = new ReconciliationService(deps);

	    const applyVerdict = vi.fn(async () => ({}));

	    await expect(
	      service.runWithDecision(
	        {
	          workspaceId: "workspace-1",
	          runId: "run-foreign",
	          signalId: "signal-1",
	          incomingContent: "The user lives in Berlin.",
	          incomingDomainTags: ["bench-seed"]
	        },
	        applyVerdict
	      )
	    ).rejects.toThrow("workspaceId does not match run workspace.");

	    expect(applyVerdict).not.toHaveBeenCalled();
	    expect(append).not.toHaveBeenCalled();
	  });

	it("a genuine ADD followed by a byte-identical re-seed collapses to NOOP and does not grow evidence_refs", async () => {
    // The store starts EMPTY. The first ingest is a genuine ADD that
    // mints exactly one evidence capsule and creates a row; that row is
    // then fed back into the neighbor pool. The second ingest of the
    // byte-identical fact must collapse to a zero-LLM NOOP, mint zero
    // capsules, and never call update — proving idempotent re-seed.
    const store: MemoryEntry[] = [];
    const { deps, update, decide, append } = createDeps(store);
    const service = new ReconciliationService(deps);

    const first = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    });
    const firstDecision = await first.decision;

    // First ingest: a genuine ADD against an empty store.
    expect(firstDecision.kind).toBe("add");
    expect(first.appliedVerdicts).toEqual(["add"]);
    expect(first.evidenceMinted()).toBe(1);
    expect(decide).not.toHaveBeenCalled();

    // The router created the row — push it into the neighbor pool so the
    // re-seed retrieves it, exactly as the live store would.
    store.push(
      createMemoryEntry({
        object_id: "memory-add-1",
        content: "The user lives in Berlin.",
        domain_tags: ["bench-seed"],
        evidence_refs: ["evidence-add-1"]
      })
    );

    const second = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    });
    const secondDecision = await second.decision;

    // Second ingest of the identical fact: zero-LLM NOOP against the row
    // the first ADD created.
    expect(secondDecision.kind).toBe("noop");
    expect(secondDecision.survivingObjectId).toBe("memory-add-1");
    expect(second.appliedVerdicts).toEqual(["noop"]);
    expect(second.evidenceMinted()).toBe(0);
    expect(decide).not.toHaveBeenCalled();
    // The surviving row is never written — evidence_refs cannot grow.
    expect(update).not.toHaveBeenCalled();
    expect(store[0]?.evidence_refs).toEqual(["evidence-add-1"]);
    // The re-seed is the only ingest that produced an audit drop.
    expect(append).toHaveBeenCalledTimes(1);
  });

it("case-distinct identifiers route to the LLM judge — not a silent NOOP", async () => {
    // "pod-A" vs "pod-a" are genuinely different facts; the zero-LLM
    // NOOP gate requires byte-identity (modulo whitespace) and must NOT
    // case-fold. The case-distinct fact reaches the semantic judge
    // instead of being silently dropped.
    const neighbor = createMemoryEntry({
      content: "The active deployment target is pod-A.",
      domain_tags: ["deploy"]
    });
    const { deps, decide } = createDeps([neighbor]);
    decide.mockResolvedValueOnce({ kind: "add", reason: "distinct pod identifier" });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The active deployment target is pod-a.",
      incomingDomainTags: ["deploy"]
    }).decision;

    // Routed to the LLM (not collapsed to a zero-LLM NOOP).
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("add");
  });

it("a near-Jaccard-but-not-identical neighbor routes to the LLM, not a silent NOOP", async () => {
    const neighbor = createMemoryEntry({ content: "The user lives in Berlin" });
    const { deps, decide } = createDeps([neighbor]);
    decide.mockResolvedValueOnce({ kind: "add", reason: "distinct enough" });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin now",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("add");
  });

it("a single-char discriminator pair is NOT collapsed — token set stays distinct", async () => {
    const neighbor = createMemoryEntry({
      content: "The user is admin of project A",
      domain_tags: ["projects"]
    });
    const { deps, decide } = createDeps([neighbor]);
    decide.mockResolvedValueOnce({ kind: "add", reason: "different project" });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user is admin of project B",
      incomingDomainTags: ["projects"]
    }).decision;

    expect(decide).toHaveBeenCalledTimes(1);
    const candidates = decide.mock.calls[0][0].candidates;
    expect(candidates[0]?.content).toBe("The user is admin of project A");
    expect(decision.kind).toBe("add");
  });

it("a neighbor at or above the floor routes into the LLM ambiguous band", async () => {
    const neighbor = createMemoryEntry({ content: "alpha beta gamma delta" });
    const { deps, decide } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.5 }
    });
    decide.mockResolvedValueOnce({ kind: "add", reason: "distinct" });
    const service = new ReconciliationService(deps);

    await drive(service, {
      incomingContent: "alpha beta gamma omega epsilon",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decide).toHaveBeenCalledTimes(1);
  });

it("ambiguous-band fact: LLM ADD verdict appends without an UPDATE", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const { deps, update, decide } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    decide.mockResolvedValueOnce({ kind: "add", reason: "different attribute" });
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("add");
    expect(driven.appliedVerdicts).toEqual(["add"]);
    expect(update).not.toHaveBeenCalled();
  });

it("ambiguous-band fact: LLM NOOP verdict drops the fact, audits it, creates nothing", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center",
      evidence_refs: ["evidence-old"]
    });
    const { deps, update, append } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "noop",
      targetObjectId: "memory-neighbor",
      reason: "equivalent"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin downtown",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("noop");
    expect(decision.survivingObjectId).toBe("memory-neighbor");
    expect(append).toHaveBeenCalledTimes(1);
    expect(driven.evidenceMinted()).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(append.mock.calls[0][0].payload_json).toMatchObject({
      dropped_content: "The user lives in Berlin downtown",
      surviving_object_id: "memory-neighbor"
    });
  });

it("a max-length distilled fact round-trips through the NOOP audit row untruncated", async () => {
    const maxLengthFact = `Berlin ${"x".repeat(493)}`;
    expect(maxLengthFact.length).toBe(500);
    const neighbor = createMemoryEntry({ content: maxLengthFact });
    const { deps, append } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: maxLengthFact,
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("noop");
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0].payload_json).toMatchObject({
      dropped_content: maxLengthFact
    });
  });

it("LLM failure degrades to ADD with the conflict scan flagged", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => {
      throw new Error("garden LLM unavailable");
    });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    // Never lose a fact — degrade to ADD and run the conflict scan.
    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

it("LLM UPDATE write failure without a visible mutation degrades to ADD", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const { deps } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryUpdate: {
        update: async () => {
          throw new Error("memory entry is archived");
        }
      }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "refines"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
    expect(driven.appliedVerdicts).toEqual(["update", "add"]);
  });

it("LLM UPDATE with an invalid target degrades to ADD", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-not-a-candidate",
      reason: "refines"
    }));
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("add");
    expect(update).not.toHaveBeenCalled();
  });

it("multi-neighbor: the highest-similarity neighbor is the LLM's first candidate", async () => {
    const weak = createMemoryEntry({
      object_id: "memory-weak",
      content: "The user lives in Berlin"
    });
    const strong = createMemoryEntry({
      object_id: "memory-strong",
      content: "The user lives in Berlin city center district"
    });
    const { deps, decide } = createDeps([weak, strong], {
      thresholds: { similarityFloor: 0.1 }
    });
    const service = new ReconciliationService(deps);

    await drive(service, {
      incomingContent: "The user lives in Berlin city center near the river",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decide).toHaveBeenCalledTimes(1);
    const candidates = decide.mock.calls[0][0].candidates;
    expect(candidates[0]?.objectId).toBe("memory-strong");
  });

it("flags runConflictScan for a same-topic divergent fact below the floor", async () => {
    const neighbor = createMemoryEntry({
      content: "The user prefers tea over coffee.",
      domain_tags: ["beverage-preference"]
    });
    const { deps } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user strongly dislikes every hot drink.",
      incomingDomainTags: ["beverage-preference"]
    }).decision;

    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
  });

it("scopes neighbors to the workspace and skips archived rows", async () => {
    const foreign = createMemoryEntry({
      object_id: "memory-foreign",
      workspace_id: "workspace-other",
      content: "The user lives in Berlin."
    });
    const archived = createMemoryEntry({
      object_id: "memory-archived",
      lifecycle_state: "archived",
      content: "The user lives in Berlin."
    });
    const { deps } = createDeps([foreign, archived]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("add");
  });
});
