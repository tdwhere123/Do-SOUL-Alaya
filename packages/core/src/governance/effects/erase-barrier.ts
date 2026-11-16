import {
  FieldGenerationEventType,
  SoulFieldEraseBarrierPayloadSchema,
  type ProjectionEraseBarrier
} from "@do-soul/alaya-protocol";
import { SYSTEM_ACTOR } from "../../shared/actors.js";
import type { EventPublisherInput } from "../../runtime/event-publisher.js";

export function buildEraseBarrierEventInput(
  barrier: Pick<
    ProjectionEraseBarrier,
    "identity" | "workspace_id" | "barrier_id" | "generation_id" |
      "subject_kind" | "subject_id" | "erased_at"
  >
): EventPublisherInput {
  return {
    event_type: FieldGenerationEventType.SOUL_FIELD_ERASE_BARRIER,
    entity_type: "projection_erase_barrier",
    entity_id: barrier.identity,
    workspace_id: barrier.workspace_id,
    run_id: null,
    caused_by: SYSTEM_ACTOR,
    payload_json: SoulFieldEraseBarrierPayloadSchema.parse({
      workspace_id: barrier.workspace_id,
      receipt_identity: barrier.identity,
      barrier_id: barrier.barrier_id,
      generation_id: barrier.generation_id,
      subject_kind: barrier.subject_kind,
      subject_id: barrier.subject_id,
      erased_at: barrier.erased_at
    })
  };
}
