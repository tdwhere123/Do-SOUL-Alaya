import { describe, expect, it, vi } from "vitest";
import {
  createTimeConcernWindowDigest,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import type { CoarseCandidateDraft } from "../../recall/coarse-filter/coarse-candidates.js";
import type { AddCoarseCandidate } from
  "../../recall/coarse-filter/coarse-filter-admission.js";
import type { RecallServiceWarnPort } from
  "../../recall/runtime/recall-service-ports.js";
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

  it("does not record path_expansion_failed for a missing historical projection generation", async () => {
    const seed = createMemoryEntry({ object_id: "seed-a" });
    const neighbor = createMemoryEntry({ object_id: "neighbor-a" });
    const warn = vi.fn();
    const degradationReasons = new Set<"path_expansion_failed">();
    const addCandidate = vi.fn(() => true);
    const missing = new Error(
      "No verified temporal projection exists for as-of 2023-05-30T23:40:00.000Z; rebuild it before recall."
    );
    missing.name = "TemporalProjectionGenerationMissingError";
    const findByAnchors = vi.fn(async () => {
      throw missing;
    });

    await addPathExpansionCandidates({
      ...seededParams(seed, neighbor, findByAnchors, warn, degradationReasons, addCandidate),
      pathProjectionAsOf: "2023-05-30T23:40:00.000Z"
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

  it("adds a canonical interval digest for relative query time concerns", async () => {
    const findByTimeConcernWindowDigests = vi.fn(async () => []);

    await addTimeConcernPathExpansionCandidates({
      ...timeConcernParams(
        findByTimeConcernWindowDigests,
        vi.fn(),
        new Set<"path_expansion_failed">(),
        vi.fn(() => true)
      ),
      pathProjectionAsOf: "2026-03-20T12:00:00.000Z"
    });

    expect(findByTimeConcernWindowDigests).toHaveBeenCalledWith(
      "workspace-1",
      [
        "yesterday",
        createTimeConcernWindowDigest(
          "2026-03-19T00:00:00.000Z",
          "2026-03-19T23:59:59.999Z"
        )
      ],
      { asOf: "2026-03-20T12:00:00.000Z" }
    );
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
  warn: RecallServiceWarnPort,
  degradationReasons: Set<"path_expansion_failed">,
  addCandidate: AddCoarseCandidate
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
  findByTimeConcernWindowDigests: () => Promise<never[]>,
  warn: RecallServiceWarnPort,
  degradationReasons: Set<"path_expansion_failed">,
  addCandidate: AddCoarseCandidate
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
