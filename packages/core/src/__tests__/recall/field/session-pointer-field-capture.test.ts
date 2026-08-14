import { describe, expect, it } from "vitest";

import { buildSessionPointerFieldCaptures } from
  "../../../recall/field/session-pointer-field-capture.js";
import { materializeRecallRetrievalFieldCaptures } from
  "../../../recall/field/finite-field-capture.js";
import type { CoarseRecallCandidate } from
  "../../../recall/runtime/recall-service-types.js";
import type { RecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

const emptyProbes = Object.freeze({
  normalized_query: "where did alice live",
  object_ids: [],
  subject_hints: [],
  evidence_refs: [],
  run_ids: [],
  surface_ids: [],
  file_paths: [],
  command_names: [],
  package_names: [],
  task_refs: [],
  dimensions: [],
  scope_classes: [],
  domain_tags: [],
  lexical_terms: ["alice", "live"],
  expanded_terms: [],
  phrases: [],
  char_ngrams: [],
  date_terms: []
}) satisfies RecallQueryProbes;

describe("session and pointer field captures", () => {
  it("seals skip when the query has no session or pointer fiber", () => {
    const [session, pointer] = buildSessionPointerFieldCaptures({
      queryProbes: emptyProbes,
      candidates: [candidate("memory-lexical", ["lexical"])]
    });

    expect(session?.channel).toMatchObject({
      channel_id: "session_event_index",
      status: "ineligible",
      depth: 0,
      unseen_upper_bound: null
    });
    expect(pointer?.channel).toMatchObject({
      channel_id: "explicit_pointer",
      status: "ineligible",
      depth: 0,
      unseen_upper_bound: null
    });
    expect(session?.channel.observations).toEqual([]);
    expect(pointer?.channel.observations).toEqual([]);
  });

  it("records admitted pointer matches and empty complete when the fiber misses", () => {
    const hit = buildSessionPointerFieldCaptures({
      queryProbes: { ...emptyProbes, object_ids: ["memory-pointer"] },
      candidates: [
        candidate("memory-pointer", ["object_probe"]),
        candidate("memory-lexical", ["lexical"])
      ]
    });
    const miss = buildSessionPointerFieldCaptures({
      queryProbes: { ...emptyProbes, object_ids: ["memory-absent"] },
      candidates: [candidate("memory-lexical", ["lexical"])]
    });

    expect(hit[0]?.channel.status).toBe("ineligible");
    expect(hit[1]?.channel).toMatchObject({
      channel_id: "explicit_pointer",
      status: "complete",
      depth: 1,
      unseen_upper_bound: 0
    });
    expect(hit[1]?.channel.observations.map(({ candidate_key }) => candidate_key))
      .toEqual(["workspace_local:memory_entry:memory-pointer"]);
    expect(miss[1]?.channel).toMatchObject({
      status: "complete",
      depth: 0,
      unseen_upper_bound: 0,
      observations: []
    });
  });

  it("records admitted session-cohort matches when a surface fiber is present", () => {
    const [session] = buildSessionPointerFieldCaptures({
      queryProbes: { ...emptyProbes, surface_ids: ["surface-shared"] },
      candidates: [
        candidate("memory-session", ["session_surface_cohort"]),
        candidate("memory-lexical", ["lexical"])
      ]
    });

    expect(session?.channel).toMatchObject({
      channel_id: "session_event_index",
      status: "complete",
      depth: 1,
      unseen_upper_bound: 0
    });
    expect(session?.channel.observations.map(({ candidate_key }) => candidate_key))
      .toEqual(["workspace_local:memory_entry:memory-session"]);
  });

  it("keeps producer receipts in the catalog instead of filling them as unavailable", () => {
    const captures = materializeRecallRetrievalFieldCaptures(
      buildSessionPointerFieldCaptures({
        queryProbes: {
          ...emptyProbes,
          object_ids: ["memory-pointer"],
          surface_ids: ["surface-shared"]
        },
        candidates: [
          candidate("memory-session", ["session_surface_cohort"]),
          candidate("memory-pointer", ["object_probe"])
        ]
      })
    );
    const unavailable = materializeRecallRetrievalFieldCaptures([]);
    const session = captures.find(({ channel }) =>
      channel.channel_id === "session_event_index");
    const pointer = captures.find(({ channel }) =>
      channel.channel_id === "explicit_pointer");

    expect(session?.channel.status).toBe("complete");
    expect(pointer?.channel.status).toBe("complete");
    expect(session?.source_snapshot_digest).not.toBe(
      unavailable.find(({ channel }) => channel.channel_id === "session_event_index")
        ?.source_snapshot_digest
    );
    expect(pointer?.source_snapshot_digest).not.toBe(
      unavailable.find(({ channel }) => channel.channel_id === "explicit_pointer")
        ?.source_snapshot_digest
    );
  });
});

function candidate(
  objectId: string,
  admissionPlanes: CoarseRecallCandidate["admissionPlanes"]
): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry({ object_id: objectId }),
    admissionPlanes,
    firstAdmissionPlane: admissionPlanes?.[0]
  };
}
