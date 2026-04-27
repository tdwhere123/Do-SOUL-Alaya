import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Evidence, MemoryObject } from "../contracts/index.js";
import {
  createSoulMemoryRuntime
} from "../runtime/index.js";

const tmpRoots: string[] = [];
const now = "2026-04-27T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SOUL Memory runtime", () => {
  it("drives ingest, recall, context, sessions, governance, export, and backup through one API", async () => {
    const root = await makeTmpRoot();
    const runtime = createSoulMemoryRuntime({
      path: join(root, "soul-memory.db"),
      now: () => now
    });
    const memory = sampleMemory("mem-local-verification", "evidence-local-verification");
    const evidence = sampleEvidence(memory.id);

    expect((await runtime.health()).ok).toBe(true);
    expect((await runtime.previewIngest({ memory, evidence: [evidence] })).accepted).toBe(true);

    const ingested = await runtime.ingestMemory({ memory, evidence: [evidence] });
    expect(ingested.memory.evidenceIds).toEqual([evidence.id]);
    expect(ingested.auditEvent.type).toBe("memory.created");

    const recall = await runtime.recall({ query: "rtk verify local prototype" });
    expect(recall.candidates).toHaveLength(1);
    expect(recall.candidates[0]).toMatchObject({
      memoryId: memory.id,
      recommendedUse: "blocking"
    });
    expect(recall.candidates[0]?.reason).toContain("Lexical recall");

    const session = await runtime.startMemorySession({
      agent: { kind: "codex", client: "local", version: "test" },
      mode: "gateway",
      project: "soul-memory",
      workspace: root
    });
    const context = await runtime.assembleContextForSession(session.session.id, {
      query: "rtk verify local prototype"
    });
    expect(context.contextPack.included[0]?.evidenceRefs[0]?.evidenceId).toBe(evidence.id);
    expect((await runtime.getMemorySession(session.session.id)).session.finishedAt).toBeUndefined();

    await runtime.recordMemoryUsage({
      event: {
        id: "usage-1",
        sessionId: session.session.id,
        kind: "recall-item-cited",
        at: now,
        memoryId: memory.id,
        contextPackId: context.contextPack.id,
        state: "used",
        proof: "test assertion",
        reason: "The generated answer cited the memory."
      }
    });
    expect((await runtime.getMemorySession(session.session.id)).session.finishedAt).toBeUndefined();
    const finished = await runtime.finishMemorySession(session.session.id, {
      finishedAt: now,
      usageState: "used",
      ingestState: "accepted"
    });
    expect(finished.session.usedMemoryIds).toEqual([memory.id]);

    const rejected = await runtime.rejectMemory({
      memoryId: memory.id,
      actor: "operator",
      reason: "testing governance audit"
    });
    expect(rejected.memory.lifecycle).toBe("rejected");
    expect(rejected.auditEvent.reason).toBe("testing governance audit");
    expect((await runtime.recall({ query: "rtk verify" })).candidates).toHaveLength(0);

    const exported = await runtime.exportBundle({ includeSessions: true });
    expect(exported.bundle.memories).toHaveLength(1);
    expect(exported.bundle.sessions).toHaveLength(1);
    expect(exported.bundle.contextPacks).toHaveLength(1);
    expect(exported.bundle.auditEvents.some((event) => event.type === "memory.rejected")).toBe(true);

    const backupPath = join(root, "backup", "soul-memory.db");
    await runtime.backup({ path: backupPath });
    expect((await stat(backupPath)).size).toBeGreaterThan(0);

    runtime.close();
  });

  it("rejects evidence-less durable ingest and rolls back failed evidence writes", async () => {
    const root = await makeTmpRoot();
    const runtime = createSoulMemoryRuntime({
      path: join(root, "soul-memory.db"),
      now: () => now
    });
    try {
      await expect(
        runtime.ingestMemory({
          memory: sampleMemory("mem-missing-evidence", "evidence-missing"),
          evidence: []
        })
      ).rejects.toThrow(/durable memory requires matching evidence/);
      expect((await runtime.listMemories()).memories.map((memory) => memory.id)).not.toContain("mem-missing-evidence");

      const first = sampleMemory("mem-first", "evidence-duplicate");
      await runtime.ingestMemory({ memory: first, evidence: [sampleEvidence(first.id, "evidence-duplicate")] });

      const second = sampleMemory("mem-second", "evidence-duplicate");
      await expect(
        runtime.ingestMemory({ memory: second, evidence: [sampleEvidence(second.id, "evidence-duplicate")] })
      ).rejects.toThrow();
      expect((await runtime.listMemories()).memories.map((memory) => memory.id)).toEqual([first.id]);
    } finally {
      runtime.close();
    }
  });

  it("exports real sessions, redacts sensitive memories, and reports duplicate import counts", async () => {
    const root = await makeTmpRoot();
    const sourceRuntime = createSoulMemoryRuntime({
      path: join(root, "source.db"),
      now: () => now
    });
    const importRuntime = createSoulMemoryRuntime({
      path: join(root, "import.db"),
      now: () => now
    });
    try {
      const portable = sampleMemory("mem-portable", "evidence-portable");
      await sourceRuntime.ingestMemory({ memory: portable, evidence: [sampleEvidence(portable.id, "evidence-portable")] });
      const session = await sourceRuntime.startMemorySession({
        agent: { kind: "codex", client: "local" },
        mode: "gateway",
        project: "soul-memory"
      });
      await sourceRuntime.assembleContextForSession(session.session.id, { query: "local prototype" });

      const hidden = sampleMemory("mem-hidden", "evidence-hidden");
      hidden.sensitivity = { level: "secret", retention: "do-not-export", reason: "test retention" };
      await sourceRuntime.ingestMemory({ memory: hidden, evidence: [sampleEvidence(hidden.id, "evidence-hidden")] });

      const redacted = sampleMemory("mem-redacted", "evidence-redacted");
      redacted.sensitivity = { level: "secret", retention: "redact-on-export", reason: "test retention" };
      redacted.content.body = "Sensitive body must not leave storage.";
      await sourceRuntime.ingestMemory({ memory: redacted, evidence: [sampleEvidence(redacted.id, "evidence-redacted")] });

      const exported = await sourceRuntime.exportBundle({ includeSessions: true });
      expect(exported.bundle.memories.map((memory) => memory.id).sort()).toEqual(["mem-portable", "mem-redacted"]);
      expect(exported.bundle.graph?.nodes.map((node) => node.id)).not.toContain("mem-hidden");
      expect(exported.bundle.graph?.nodes.map((node) => node.id)).not.toContain("evidence-hidden");
      expect(exported.bundle.memories.find((memory) => memory.id === "mem-redacted")?.content.summary).toBe(
        "Sensitive memory redacted for export."
      );
      expect(exported.bundle.evidence.find((evidence) => evidence.id === "evidence-redacted")?.payload).toMatchObject({
        redacted: true
      });
      expect(exported.bundle.sessions).toHaveLength(1);
      expect(exported.bundle.contextPacks).toHaveLength(1);

      const firstImport = await importRuntime.importBundle({ bundle: exported.bundle, mode: "merge" });
      expect(firstImport.importedMemoryIds.sort()).toEqual(["mem-portable", "mem-redacted"]);
      const duplicateImport = await importRuntime.importBundle({ bundle: exported.bundle, mode: "merge" });
      expect(duplicateImport.importedMemoryIds).toEqual([]);
      expect(duplicateImport.auditEvent.reason).toContain("skipped 2 existing memories");
    } finally {
      sourceRuntime.close();
      importRuntime.close();
    }
  });

  it("keeps scoped exports from leaking other scopes through side-channel sections", async () => {
    const root = await makeTmpRoot();
    const runtime = createSoulMemoryRuntime({
      path: join(root, "scoped.db"),
      now: () => now
    });
    try {
      const memoryA = sampleMemory("mem-scope-a", "evidence-scope-a");
      memoryA.scopeId = "scope-a";
      memoryA.content.summary = "alpha scoped export memory";
      memoryA.content.body = "alpha scoped export memory body";
      const memoryB = sampleMemory("mem-scope-b", "evidence-scope-b");
      memoryB.scopeId = "scope-b";
      memoryB.content.summary = "beta scoped export memory";
      memoryB.content.body = "beta scoped export memory body";
      await runtime.ingestMemory({ memory: memoryA, evidence: [sampleEvidence(memoryA.id, "evidence-scope-a")] });
      await runtime.ingestMemory({ memory: memoryB, evidence: [sampleEvidence(memoryB.id, "evidence-scope-b")] });

      const sessionA = await runtime.startMemorySession({ agent: { kind: "codex" }, mode: "gateway" });
      await runtime.assembleContextForSession(sessionA.session.id, { query: "alpha" });
      await runtime.finishMemorySession(sessionA.session.id, { finishedAt: now, usageState: "delivered", ingestState: "skipped" });
      const sessionB = await runtime.startMemorySession({ agent: { kind: "codex" }, mode: "gateway" });
      await runtime.assembleContextForSession(sessionB.session.id, { query: "beta" });
      await runtime.finishMemorySession(sessionB.session.id, { finishedAt: now, usageState: "delivered", ingestState: "skipped" });

      const exported = await runtime.exportBundle({ scopeIds: ["scope-a"], includeSessions: true });
      expect(exported.bundle.memories.map((memory) => memory.id)).toEqual(["mem-scope-a"]);
      expect(exported.bundle.scopes.map((scope) => scope.id)).toEqual(["scope-a"]);
      expect(exported.bundle.evidence.map((evidence) => evidence.id)).toEqual(["evidence-scope-a"]);
      expect(exported.bundle.graph?.nodes.map((node) => node.id).sort()).toEqual([
        "evidence-scope-a",
        "mem-scope-a",
        "scope-a"
      ]);
      expect(exported.bundle.auditEvents.map((event) => event.target.id)).not.toContain("mem-scope-b");
      expect(exported.bundle.contextPacks?.flatMap((pack) => pack.included.map((entry) => entry.memoryId))).toEqual([
        "mem-scope-a"
      ]);
      expect(exported.bundle.sessions?.map((session) => session.id)).toEqual([sessionA.session.id]);
    } finally {
      runtime.close();
    }
  });

  it("rolls back merge import when a later memory fails", async () => {
    const root = await makeTmpRoot();
    const sourceRuntime = createSoulMemoryRuntime({
      path: join(root, "import-source.db"),
      now: () => now
    });
    const targetRuntime = createSoulMemoryRuntime({
      path: join(root, "import-target.db"),
      now: () => now
    });
    try {
      const memoryA = sampleMemory("mem-import-a", "evidence-import-a");
      const memoryB = sampleMemory("mem-import-b", "evidence-collide");
      await sourceRuntime.ingestMemory({ memory: memoryA, evidence: [sampleEvidence(memoryA.id, "evidence-import-a")] });
      await sourceRuntime.ingestMemory({ memory: memoryB, evidence: [sampleEvidence(memoryB.id, "evidence-collide")] });
      const bundle = (await sourceRuntime.exportBundle()).bundle;

      const existing = sampleMemory("mem-existing", "evidence-collide");
      await targetRuntime.ingestMemory({ memory: existing, evidence: [sampleEvidence(existing.id, "evidence-collide")] });

      await expect(targetRuntime.importBundle({ bundle, mode: "merge" })).rejects.toThrow(/Failed to add evidence/);
      expect((await targetRuntime.listMemories()).memories.map((memory) => memory.id)).toEqual(["mem-existing"]);
    } finally {
      sourceRuntime.close();
      targetRuntime.close();
    }
  });

  it("does not let finishMemorySession claim used memory without delivery and usage proof", async () => {
    const root = await makeTmpRoot();
    const runtime = createSoulMemoryRuntime({
      path: join(root, "session-trust.db"),
      now: () => now
    });
    try {
      const session = await runtime.startMemorySession({ agent: { kind: "codex" }, mode: "gateway" });
      const finished = await runtime.finishMemorySession(session.session.id, {
        finishedAt: now,
        usageState: "used",
        ingestState: "skipped"
      });
      expect(finished.session.usageState).toBe("unverifiable");
      expect(finished.session.usedMemoryIds).toEqual([]);
      expect(finished.session.violationSummary.important).toBe(1);
      expect((await runtime.listSessionViolations({ sessionId: session.session.id })).violations).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it("downgrades used memory usage events that do not include proof", async () => {
    const root = await makeTmpRoot();
    const runtime = createSoulMemoryRuntime({
      path: join(root, "usage-proof.db"),
      now: () => now
    });
    try {
      const memory = sampleMemory("mem-usage-proof", "evidence-usage-proof");
      memory.content.summary = "usage proof memory";
      memory.content.body = "usage proof memory body";
      await runtime.ingestMemory({ memory, evidence: [sampleEvidence(memory.id, "evidence-usage-proof")] });
      const session = await runtime.startMemorySession({ agent: { kind: "codex" }, mode: "gateway" });
      const context = await runtime.assembleContextForSession(session.session.id, { query: "usage proof" });
      const usage = await runtime.recordMemoryUsage({
        event: {
          id: "usage-without-proof",
          sessionId: session.session.id,
          kind: "recall-item-cited",
          at: now,
          memoryId: memory.id,
          contextPackId: context.contextPack.id,
          state: "used",
          reason: "missing concrete proof"
        }
      });
      expect(usage.event.state).toBe("unverifiable");
      expect(usage.session.usedMemoryIds).toEqual([]);
      expect(usage.session.violationSummary.important).toBe(1);

      const finished = await runtime.finishMemorySession(session.session.id, {
        finishedAt: now,
        usageState: "used",
        ingestState: "skipped"
      });
      expect(finished.session.usageState).toBe("unverifiable");
      expect(finished.session.usedMemoryIds).toEqual([]);
    } finally {
      runtime.close();
    }
  });
});

function sampleMemory(id = "mem-local-verification", evidenceId = "evidence-local-verification"): MemoryObject {
  return {
    id,
    plane: "project-local",
    scopeId: "scope-local-prototype",
    kind: "constraint",
    durability: "durable",
    lifecycle: "accepted",
    content: {
      summary: "Use rtk and verify local prototype changes before claiming completion.",
      body: "Local SOUL Memory prototype work stays under .local and must be verified with tsc and Vitest."
    },
    facets: [{ key: "topic", value: "verification", confidence: 1 }],
    source: {
      id: "source-user-plan",
      type: "operator",
      ref: "prototype-plan",
      actor: "operator",
      observedAt: now
    },
    evidenceIds: [evidenceId],
    confidence: 0.95,
    strength: 0.9,
    createdAt: now,
    tags: ["workflow", "prototype"]
  };
}

function sampleEvidence(memoryId: string, id = "evidence-local-verification"): Evidence {
  return {
    id,
    type: "operator-statement",
    source: {
      id: "source-user-plan",
      type: "operator",
      ref: "prototype-plan",
      actor: "operator",
      observedAt: now
    },
    summary: "The plan requires local-only implementation and verification.",
    payload: {
      memoryId,
      quote: "Do not modify tracked main repo packages."
    },
    createdAt: now,
    confidence: 1
  };
}

async function makeTmpRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "soul-memory-runtime-"));
  tmpRoots.push(path);
  return path;
}
