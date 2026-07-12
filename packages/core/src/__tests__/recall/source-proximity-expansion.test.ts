import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { CoarseCandidateDraft } from "../../recall/coarse-filter/coarse-candidates.js";
import { addSourceProximityCandidates } from "../../recall/expansion/source-proximity-expansion.js";
import type { RecallServiceDependencies } from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

interface SourceAnchor {
  readonly evidence_object_id: string;
  readonly artifact_ref: string;
}

describe("source proximity expansion", () => {
  it("matches full hydration with one bounded lookup for all tier evidence refs", async () => {
    const fixture = createFixture();
    const baseline = await runExpansion(fixture, legacyPort(fixture.anchors));
    const findByIds = vi.fn(async () => []);
    const findSourceAnchorsByIds = vi.fn(async (
      _workspaceId: string,
      ids: readonly string[]
    ) => fixture.anchors.filter((anchor) => ids.includes(anchor.evidence_object_id)));

    const optimized = await runExpansion(fixture, {
      searchByKeyword: vi.fn(async () => []),
      findByIds,
      findSourceAnchorsByIds
    } as unknown as NonNullable<RecallServiceDependencies["evidenceSearchPort"]>);

    expect(optimized).toEqual(baseline);
    expect(findByIds).not.toHaveBeenCalled();
    expect(findSourceAnchorsByIds).toHaveBeenCalledOnce();
    expect(findSourceAnchorsByIds).toHaveBeenCalledWith(
      "workspace-1",
      expect.arrayContaining(fixture.anchors.map((anchor) => anchor.evidence_object_id))
    );
    expect(findSourceAnchorsByIds.mock.calls[0]?.[1]).toHaveLength(7);
    expect(optimized.admitted.map(({ id }) => id)).toEqual(["memory-direct", "memory-near"]);
  });

  it("falls back observably to full hydration when indexed anchor lookup fails", async () => {
    const fixture = createFixture();
    const warn = vi.fn();
    const findByIds = vi.fn(legacyFindByIds(fixture.anchors));
    const result = await runExpansion(fixture, {
      searchByKeyword: vi.fn(async () => []),
      findByIds,
      findSourceAnchorsByIds: vi.fn(async () => {
        throw new Error("anchor index unavailable");
      })
    } as unknown as NonNullable<RecallServiceDependencies["evidenceSearchPort"]>, warn);

    expect(result).toEqual(await runExpansion(fixture, legacyPort(fixture.anchors)));
    expect(findByIds).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "evidence source-anchor id lookup failed; using full capsule hydration",
      expect.objectContaining({
        workspace_id: "workspace-1",
        operation: "evidence_source_anchor_id_lookup",
        error: "anchor index unavailable"
      })
    );
  });

  it("reports full hydration when the scalar anchor port is unavailable", async () => {
    const fixture = createFixture();
    const warn = vi.fn();
    const findByIds = vi.fn(legacyFindByIds(fixture.anchors));

    const result = await runExpansion(fixture, {
      searchByKeyword: vi.fn(async () => []),
      findByIds
    } as unknown as NonNullable<RecallServiceDependencies["evidenceSearchPort"]>, warn);

    expect(result).toEqual(await runExpansion(fixture, legacyPort(fixture.anchors)));
    expect(findByIds).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "evidence source-anchor id lookup unavailable; using full capsule hydration",
      expect.objectContaining({
        workspace_id: "workspace-1",
        operation: "evidence_source_anchor_id_lookup",
        reason: "scalar_anchor_port_unavailable"
      })
    );
  });

  it.each([
    ["mixed-case Unicode", {
      seed: "ÄDoc-s1-t10",
      near: "ädOC-s1-t15",
      direct: "ädoc-s1-t9",
      outside: "ädoc-s1-t17",
      other: "other-s1-t10"
    }],
    ["source refs without prefixes", {
      seed: "-s1-t10",
      near: "-s1-t15",
      direct: "-s1-t9",
      outside: "-s1-t17",
      other: "other-s1-t10"
    }]
  ])("keeps bounded-id parity for %s", async (_label, sourceRefs) => {
    const fixture = createFixture(sourceRefs);
    const warn = vi.fn();
    const findByIds = vi.fn(legacyFindByIds(fixture.anchors));
    const findSourceAnchorsByIds = vi.fn(async (
      _workspaceId: string,
      ids: readonly string[]
    ) => fixture.anchors.filter((anchor) => ids.includes(anchor.evidence_object_id)));
    const optimized = await runExpansion(fixture, {
      searchByKeyword: vi.fn(async () => []),
      findByIds,
      findSourceAnchorsByIds
    } as unknown as NonNullable<RecallServiceDependencies["evidenceSearchPort"]>, warn);

    expect(optimized).toEqual(await runExpansion(fixture, legacyPort(fixture.anchors)));
    expect(optimized.admitted.map(({ id }) => id)).toEqual(["memory-direct", "memory-near"]);
    expect(findSourceAnchorsByIds).toHaveBeenCalledOnce();
    expect(findByIds).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

interface FixtureSourceRefs {
  readonly seed: string;
  readonly near: string;
  readonly direct: string;
  readonly outside: string;
  readonly other: string;
}

function createFixture(sourceRefs: FixtureSourceRefs = {
  seed: "doc-s1-t10",
  near: "doc-s1-t15",
  direct: "doc-s1-t9",
  outside: "doc-s1-t17",
  other: "other-s1-t10"
}) {
  const entries = [
    memory("memory-seed", ["capsule-seed-a", "capsule-seed-b"]),
    memory("memory-near", ["capsule-near", "capsule-near"]),
    memory("memory-direct", [sourceRefs.direct]),
    memory("memory-outside", ["capsule-outside"]),
    memory("memory-other", ["capsule-other"]),
    memory("memory-missing", ["capsule-missing"])
  ];
  const anchors: readonly SourceAnchor[] = [
    { evidence_object_id: "capsule-seed-a", artifact_ref: sourceRefs.seed },
    { evidence_object_id: "capsule-seed-b", artifact_ref: sourceRefs.seed },
    { evidence_object_id: "capsule-near", artifact_ref: sourceRefs.near },
    { evidence_object_id: "capsule-outside", artifact_ref: sourceRefs.outside },
    { evidence_object_id: "capsule-other", artifact_ref: sourceRefs.other }
  ];
  return { entries, anchors };
}

function memory(objectId: string, evidenceRefs: readonly string[]): Readonly<MemoryEntry> {
  return createMemoryEntry({ object_id: objectId, evidence_refs: [...evidenceRefs] });
}

async function runExpansion(
  fixture: ReturnType<typeof createFixture>,
  evidenceSearchPort: NonNullable<RecallServiceDependencies["evidenceSearchPort"]>,
  warn = vi.fn()
) {
  const seed = fixture.entries[0]!;
  const drafts = new Map<string, CoarseCandidateDraft>([[seed.object_id, draft(seed)]]);
  const admitted: Array<{ readonly id: string; readonly score: number }> = [];
  const sourceCohortKeys = await addSourceProximityCandidates({
    workspaceId: "workspace-1",
    tierMemories: fixture.entries,
    drafts,
    addCandidate: (entry, _plane, score) => {
      if (drafts.has(entry.object_id)) return false;
      drafts.set(entry.object_id, draft(entry));
      admitted.push({ id: entry.object_id, score });
      return true;
    },
    admissionLimit: 20,
    evidenceSearchPort,
    robustSourceRefParsing: true,
    warn
  });
  return { admitted, sourceCohortKeys };
}

function draft(entry: Readonly<MemoryEntry>): CoarseCandidateDraft {
  return {
    entry,
    admissionPlanes: ["lexical"],
    firstAdmissionPlane: "lexical",
    sourceChannels: ["lexical"],
    structuralScore: 1,
    pathExpansionSources: []
  };
}

function legacyPort(
  anchors: readonly SourceAnchor[]
): NonNullable<RecallServiceDependencies["evidenceSearchPort"]> {
  return {
    searchByKeyword: vi.fn(async () => []),
    findByIds: vi.fn(legacyFindByIds(anchors))
  } as unknown as NonNullable<RecallServiceDependencies["evidenceSearchPort"]>;
}

function legacyFindByIds(anchors: readonly SourceAnchor[]) {
  return async (workspaceId: string, ids: readonly string[]) => anchors
    .filter((anchor) => ids.includes(anchor.evidence_object_id))
    .map((anchor) => ({
      workspace_id: workspaceId,
      object_id: anchor.evidence_object_id,
      physical_anchor: { artifact_ref: anchor.artifact_ref }
    })) as never;
}
