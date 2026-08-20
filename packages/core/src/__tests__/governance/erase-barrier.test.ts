import { describe, expect, it } from "vitest";
import {
  ProjectionEraseBarrierSchema
} from "@do-soul/alaya-protocol";
import {
  EventLogSafeEraseBarrier,
  InMemoryEraseBarrierStore,
  InMemoryEraseSubjectStore
} from "../../governance/effects/erase-barrier.js";

const RECORDED = "2026-08-16T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("EventLogSafeEraseBarrier", () => {
  it("clears plaintext, persists the barrier only, and refuses rollback", () => {
    const subjects = new InMemoryEraseSubjectStore();
    const barriers = new InMemoryEraseBarrierStore();
    subjects.seed("workspace-1", "source-1", "secret excerpt about a person");
    const erase = new EventLogSafeEraseBarrier({ subjects, barriers });

    const stored = erase.erase(barrier());

    expect(subjects.getPlaintext("workspace-1", "source-1")).toBeNull();
    expect(stored.subject_id).toBe("source-1");
    expect(JSON.stringify(stored)).not.toMatch(/secret excerpt/u);
    expect(() => ProjectionEraseBarrierSchema.parse({
      ...barrier(),
      excerpt: "secret excerpt"
    })).toThrow();
    expect(() => erase.restorePlaintext(
      "workspace-1",
      "source-1",
      "secret excerpt about a person"
    )).toThrow(/irreversible/u);
    expect(subjects.getPlaintext("workspace-1", "source-1")).toBeNull();
    expect(erase.erase(barrier())).toEqual(stored);
    expect(barriers.get("workspace-1", "barrier-1")).toEqual(stored);
  });
});

function barrier() {
  return ProjectionEraseBarrierSchema.parse({
    schema_version: 1,
    producer: "erase_barrier",
    consumer: "projection_generation",
    identity: DIGEST,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "tombstone",
    deletion_behavior: "content_free_tombstone",
    workspace_id: "workspace-1",
    barrier_id: "barrier-1",
    generation_id: null,
    subject_kind: "source_record",
    subject_id: "source-1",
    erased_at: RECORDED
  });
}
