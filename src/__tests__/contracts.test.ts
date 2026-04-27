import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXPORT_BUNDLE_SCHEMA_VERSION,
  type ContextPack,
  type Evidence,
  type ExportBundle,
  type MemoryObject,
  type MemorySession,
  type Scope,
  validateContextPack,
  validateExportBundle,
  validateMemoryObject,
  validateMemorySession
} from "../contracts/index.js";

const now = "2026-04-27T00:00:00.000Z";

const source = {
  id: "source-1",
  type: "operator",
  ref: "local-test",
  actor: "operator",
  observedAt: now
} as const;

const evidence: Evidence = {
  id: "evidence-1",
  type: "operator-statement",
  source,
  summary: "Operator supplied the memory.",
  payload: { statement: "Use evidence-backed memory." },
  createdAt: now,
  confidence: 1
};

const scope: Scope = {
  id: "scope-1",
  plane: "project-local",
  kind: "repo",
  name: "Prototype repo",
  identity: "/home/tdwhere/vibe/do-what-new"
};

const durableMemory: MemoryObject = {
  id: "memory-1",
  plane: "project-local",
  scopeId: scope.id,
  kind: "constraint",
  durability: "durable",
  lifecycle: "accepted",
  content: {
    summary: "Durable memory must cite source and evidence."
  },
  facets: [{ key: "topic", value: "governance", confidence: 1 }],
  source,
  evidenceIds: [evidence.id],
  confidence: 0.95,
  strength: 0.9,
  createdAt: now
};

describe("SOUL Memory contracts", () => {
  it("requires durable memories to carry source and evidence", () => {
    expect(validateMemoryObject(durableMemory)).toBe(durableMemory);

    expect(() =>
      validateMemoryObject({
        ...durableMemory,
        evidenceIds: []
      })
    ).toThrow(/memory\.evidenceIds: durable memory requires at least one evidence id/);

    expect(() =>
      validateMemoryObject({
        ...durableMemory,
        source: null
      })
    ).toThrow(/memory\.source: durable memory requires a source reference/);
  });

  it("requires recall context entries and exclusions to be explainable", () => {
    const contextPack: ContextPack = {
      id: "context-pack-1",
      sessionId: "session-1",
      query: "How should contracts encode governance?",
      planePolicy: "all-day-one",
      recallPolicyVersion: "recall-v1",
      createdAt: now,
      included: [
        {
          id: "entry-1",
          memoryId: durableMemory.id,
          plane: "project-local",
          rank: 0,
          score: 0.87,
          reason: "Project-local governance contract directly matches the task.",
          recommendedUse: "blocking",
          evidenceRefs: [{ evidenceId: evidence.id, sourceId: source.id }],
          sourceRef: source
        }
      ],
      excluded: [
        {
          id: "exclusion-1",
          memoryId: "memory-old",
          plane: "global-personal",
          reason: "Project-local evidence is more specific.",
          evidenceRefs: [{ evidenceId: evidence.id }],
          lifecycle: "superseded",
          supersededByMemoryId: durableMemory.id
        }
      ],
      totalIncludedCount: 1,
      totalExcludedCount: 1,
      explanationSummary: "Local project rule wins and excluded global background is reported."
    };

    expect(validateContextPack(contextPack)).toBe(contextPack);

    expect(() =>
      validateContextPack({
        ...contextPack,
        included: [{ ...contextPack.included[0], reason: "" }]
      })
    ).toThrow(/contextPack\.included\[0\]\.reason: expected non-empty string/);

    expect(() =>
      validateContextPack({
        ...contextPack,
        excluded: [{ ...contextPack.excluded[0], reason: "" }]
      })
    ).toThrow(/contextPack\.excluded\[0\]\.reason: expected non-empty string/);
  });

  it("keeps session delivery, use, skip, and unverifiable states separate", () => {
    const session: MemorySession = {
      id: "session-1",
      agent: { kind: "codex", client: "local", version: "test" },
      mode: "attach",
      project: "SOUL Memory",
      workspace: "/home/tdwhere/vibe/do-what-new",
      startedAt: now,
      contextPackId: "context-pack-1",
      usageState: "mixed",
      ingestState: "previewed",
      deliveredMemoryIds: ["memory-1", "memory-2", "memory-3"],
      usedMemoryIds: ["memory-1"],
      skippedMemoryIds: ["memory-2"],
      unverifiableMemoryIds: ["memory-3"],
      violationSummary: {
        blocking: 0,
        important: 0,
        niceToHave: 0
      }
    };

    expect(validateMemorySession(session)).toBe(session);

    expect(() =>
      validateMemorySession({
        ...session,
        usedMemoryIds: ["memory-not-delivered"]
      })
    ).toThrow(/memorySession\.usedMemoryIds: memory id 'memory-not-delivered' was not delivered/);
  });

  it("validates portable import and export bundles", () => {
    const bundle: ExportBundle = {
      schemaVersion: EXPORT_BUNDLE_SCHEMA_VERSION,
      exportedAt: now,
      scopes: [scope],
      memories: [durableMemory],
      evidence: [evidence],
      auditEvents: [
        {
          id: "audit-1",
          type: "memory.accepted",
          at: now,
          actor: "operator",
          target: { type: "memory", id: durableMemory.id },
          reason: "Accepted with cited evidence.",
          evidenceRefs: [{ evidenceId: evidence.id, sourceId: source.id }]
        }
      ]
    };

    expect(validateExportBundle(bundle)).toBe(bundle);

    expect(() =>
      validateExportBundle({
        ...bundle,
        memories: [{ ...durableMemory, evidenceIds: ["missing-evidence"] }]
      })
    ).toThrow(/bundle\.memories\[0\]: memory\.evidenceIds: unknown evidence id 'missing-evidence'/);
  });

  it("stays standalone without @do-what imports", () => {
    const contractsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../contracts/index.ts"
    );
    const contractsSource = readFileSync(contractsPath, "utf8");

    expect(contractsSource).not.toContain("@do-what/");
  });
});
