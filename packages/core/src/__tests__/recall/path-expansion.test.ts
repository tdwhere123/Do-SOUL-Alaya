import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { CoarseCandidateDraft } from "../../recall/coarse-filter/coarse-candidates.js";
import {
  addPathExpansionCandidates,
  addTimeConcernPathExpansionCandidates
} from "../../recall/expansion/path-expansion.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { LegacyPathIndexUnboundError } from "../../recall/runtime/legacy-path-index-unbound-error.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("path expansion index faults", () => {
  it("does not record path_expansion_failed for an unbound legacy path index", async () => {
    const seed = createMemoryEntry({ object_id: "seed-a" });
    const neighbor = createMemoryEntry({ object_id: "neighbor-a" });
    const warn = vi.fn();
    const degradationReasons = new Set<"path_expansion_failed">();
    const addCandidate = vi.fn(() => true);
    const findByAnchors = vi.fn(async () => {
      throw new LegacyPathIndexUnboundError();
    });

    await addPathExpansionCandidates({
      ...seededParams(seed, neighbor, findByAnchors, warn, degradationReasons, addCandidate)
    });

    expect(addCandidate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(degradationReasons.size).toBe(0);
  });

  it("still degrades a storage fault during path expansion", async () => {
    const seed = createMemoryEntry({ object_id: "seed-a" });
    const neighbor = createMemoryEntry({ object_id: "neighbor-a" });
    const warn = vi.fn();
    const degradationReasons = new Set<"path_expansion_failed">();
    const addCandidate = vi.fn(() => true);
    const findByAnchors = vi.fn(async () => {
      throw sqliteFault();
    });

    await addPathExpansionCandidates({
      ...seededParams(seed, neighbor, findByAnchors, warn, degradationReasons, addCandidate)
    });

    expect(addCandidate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(degradationReasons).toEqual(new Set(["path_expansion_failed"]));
  });

  it("does not record path_expansion_failed for an unbound time-concern lookup", async () => {
    const warn = vi.fn();
    const degradationReasons = new Set<"path_expansion_failed">();
    const addCandidate = vi.fn(() => true);
    const findByTimeConcernWindowDigests = vi.fn(async () => {
      throw new LegacyPathIndexUnboundError();
    });

    const added = await addTimeConcernPathExpansionCandidates({
      ...timeConcernParams(findByTimeConcernWindowDigests, warn, degradationReasons, addCandidate)
    });

    expect(added).toBe(0);
    expect(addCandidate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(degradationReasons.size).toBe(0);
  });

  it("still degrades a storage fault during time-concern path expansion", async () => {
    const warn = vi.fn();
    const degradationReasons = new Set<"path_expansion_failed">();
    const addCandidate = vi.fn(() => true);
    const findByTimeConcernWindowDigests = vi.fn(async () => {
      throw sqliteFault();
    });

    const added = await addTimeConcernPathExpansionCandidates({
      ...timeConcernParams(findByTimeConcernWindowDigests, warn, degradationReasons, addCandidate)
    });

    expect(added).toBe(0);
    expect(addCandidate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(degradationReasons).toEqual(new Set(["path_expansion_failed"]));
  });
});

function sqliteFault(): Error {
  const error = new Error("database disk image is malformed");
  error.name = "SqliteError";
  return error;
}

function seedDraft(entry: MemoryEntry): CoarseCandidateDraft {
  return {
    entry,
    admissionPlanes: ["lexical"],
    firstAdmissionPlane: "lexical",
    sourceChannels: ["fts"],
    structuralScore: 0.8,
    pathExpansionSources: []
  };
}

function seededParams(
  seed: MemoryEntry,
  neighbor: MemoryEntry,
  findByAnchors: () => Promise<never>,
  warn: ReturnType<typeof vi.fn>,
  degradationReasons: Set<"path_expansion_failed">,
  addCandidate: ReturnType<typeof vi.fn>
) {
  return {
    workspaceId: "workspace-1",
    byId: new Map([
      [seed.object_id, seed],
      [neighbor.object_id, neighbor]
    ]),
    drafts: new Map([[seed.object_id, seedDraft(seed)]]),
    queryProbes: compileRecallQueryProbes("path expansion lookup"),
    addCandidate,
    dynamicRecallPlaneCap: 10,
    pathExpansionPort: { findByAnchors },
    warn,
    degradationReasons
  };
}

function timeConcernParams(
  findByTimeConcernWindowDigests: () => Promise<never>,
  warn: ReturnType<typeof vi.fn>,
  degradationReasons: Set<"path_expansion_failed">,
  addCandidate: ReturnType<typeof vi.fn>
) {
  return {
    workspaceId: "workspace-1",
    byId: new Map<string, MemoryEntry>(),
    queryProbes: {
      ...compileRecallQueryProbes("path expansion lookup"),
      date_terms: ["yesterday"]
    },
    addCandidate,
    dynamicRecallPlaneCap: 10,
    pathExpansionPort: {
      findByAnchors: vi.fn(async () => {
        throw new Error("seeded lookup must not run");
      }),
      findByTimeConcernWindowDigests
    },
    warn,
    degradationReasons
  };
}
