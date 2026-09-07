import { formatGardenSourceTurnFallbackArtifactRef, formatGardenSourceTurnFallbackSourceHash, type EvidenceCapsule } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { buildDirectEvidencePseudoMemoryEntry, isDirectRecallEvidence } from "../../../recall/coarse-filter/evidence/direct-evidence-candidate.js";
import { selectExpansionSeedDrafts, selectPreferredExpansionSeedEntries } from "../../../recall/coarse-filter/coarse-candidates.js";

const evidence: EvidenceCapsule = {
  object_id: "00000000-0000-4000-8000-000000000101", object_kind: "evidence_capsule",
  schema_version: 1, lifecycle_state: "active", created_at: "2026-07-25T00:00:00.000Z",
  updated_at: "2026-07-25T00:00:00.000Z", created_by: "garden_compile",
  evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "color", keywords: ["blue"], summary: "blue option" },
  event_anchor: null, physical_anchor: { file_path: null, line_range: null, symbol_name: null,
    artifact_ref: formatGardenSourceTurnFallbackArtifactRef("turn-1:assistant") },
  evidence_health_state: "verified", gist: "Assistant recommended blue.", excerpt: "blue option",
  source_hash: formatGardenSourceTurnFallbackSourceHash("a".repeat(64)),
  run_id: "run-1", workspace_id: "workspace-1", surface_id: "surface-1"
};

describe("retained evidence owner admission helpers", () => {
  it("keeps the valid envelope while requiring matching workspace and receipt format", () => {
    expect(isDirectRecallEvidence(evidence, "workspace-1")).toBe(true);
    expect(isDirectRecallEvidence(evidence, "workspace-2")).toBe(false);
    expect(isDirectRecallEvidence({ ...evidence, source_hash: null }, "workspace-1")).toBe(false);
    expect(isDirectRecallEvidence({ ...evidence, physical_anchor: null }, "workspace-1")).toBe(false);
  });
  it("rejects inactive and unverified evidence", () => {
    expect(isDirectRecallEvidence({ ...evidence, lifecycle_state: "dormant" }, "workspace-1")).toBe(false);
    expect(isDirectRecallEvidence({ ...evidence, evidence_health_state: "questionable" }, "workspace-1")).toBe(false);
  });
  it("bounds the owner preview without discarding its evidence identity", () => {
    const entry = buildDirectEvidencePseudoMemoryEntry({ ...evidence, excerpt: "blue option ".repeat(100) + "tail answer" }, 0.9);
    expect(entry.content.length).toBeLessThanOrEqual(601);
    expect(entry.content.endsWith("…")).toBe(true);
    expect(entry.content).not.toContain("tail answer");
    expect(entry.evidence_refs).toEqual([evidence.object_id]);
  });
  it("does not expose a capsule as graph or content-expansion seed", () => {
    const drafts = new Map([[evidence.object_id, {
      entry: buildDirectEvidencePseudoMemoryEntry(evidence, 0.95), objectKind: "evidence_capsule" as const,
      admissionPlanes: ["lexical" as const], firstAdmissionPlane: "lexical" as const,
      sourceChannels: ["evidence_fts_direct"], structuralScore: 0.95, pathExpansionSources: []
    }]]);
    expect(selectExpansionSeedDrafts(drafts)).toEqual([]);
    expect(selectPreferredExpansionSeedEntries(drafts)).toEqual([]);
  });
});
