import { describe, expect, it } from "vitest";
import {
  FieldGenerationEventType,
  ProjectionEraseBarrierSchema
} from "@do-soul/alaya-protocol";
import {
  EventLogSafeEraseBarrier,
  InMemoryEraseBarrierStore,
  InMemoryEraseSubjectStore,
  InMemoryGovernanceEventLog
} from "../../governance/effects/erase-barrier.js";

const RECORDED = "2026-08-16T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("EventLogSafeEraseBarrier", () => {
  it("clears plaintext, appends a content-free EventLog tombstone, and refuses rollback", () => {
    const subjects = new InMemoryEraseSubjectStore();
    const barriers = new InMemoryEraseBarrierStore();
    const eventLog = new InMemoryGovernanceEventLog(() => RECORDED);
    subjects.seed("workspace-1", "source-1", "secret excerpt about a person");
    const erase = new EventLogSafeEraseBarrier({ subjects, barriers, eventLog });

    const stored = erase.erase(barrier());

    expect(subjects.getPlaintext("workspace-1", "source-1")).toBeNull();
    expect(stored.subject_id).toBe("source-1");
    expect(eventLog.entries).toHaveLength(1);
    expect(eventLog.entries[0]).toMatchObject({
      event_type: FieldGenerationEventType.SOUL_FIELD_ERASE_BARRIER,
      entity_type: "projection_erase_barrier",
      payload_json: {
        workspace_id: "workspace-1",
        barrier_id: "barrier-1",
        subject_id: "source-1",
        subject_kind: "source_record"
      }
    });
    expect(JSON.stringify(eventLog.entries[0]?.payload_json)).not.toMatch(/secret excerpt/u);
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
    expect(eventLog.entries).toHaveLength(1);
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
