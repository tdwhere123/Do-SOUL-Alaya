import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";

const healthEventKindValues = [
  "bankruptcy",
  "arbitration",
  "garden_backlog",
  "evidence_failure",
  "pointer_failure",
  "pointer_repair",
  "correction_chains",
  "green_piercing_distribution",
  "provider_call",
  "embedding_supplement",
  "recall_tuning",
  "green_revoke_noop"
] as const;

export const HealthEventKind = {
  BANKRUPTCY: "bankruptcy",
  ARBITRATION: "arbitration",
  GARDEN_BACKLOG: "garden_backlog",
  EVIDENCE_FAILURE: "evidence_failure",
  POINTER_FAILURE: "pointer_failure",
  POINTER_REPAIR: "pointer_repair",
  CORRECTION_CHAINS: "correction_chains",
  GREEN_PIERCING_DISTRIBUTION: "green_piercing_distribution",
  PROVIDER_CALL: "provider_call",
  EMBEDDING_SUPPLEMENT: "embedding_supplement",
  RECALL_TUNING: "recall_tuning",
  // invariant: emitted when GreenService.revokeStatement matches zero rows
  // under the workspace+state predicate. The associated SOUL_GREEN_REVOKED
  // EventLog row is rolled back inside the same SQLite transaction so audit
  // count tracks real revokes only.
  GREEN_REVOKE_NOOP: "green_revoke_noop"
} as const;

export const HealthEventKindSchema = z.enum(healthEventKindValues);

export const HealthJournalEntrySchema = z
  .object({
    entry_id: NonEmptyStringSchema,
    event_kind: HealthEventKindSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    summary: NonEmptyStringSchema,
    detail_json: z.record(z.unknown()),
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type HealthEventKindValue = z.infer<typeof HealthEventKindSchema>;
export type HealthJournalEntry = z.infer<typeof HealthJournalEntrySchema>;
export type HealthJournalRecordInput = Omit<HealthJournalEntry, "entry_id" | "created_at">;

export interface HealthJournalRecordPort {
  record(entry: HealthJournalRecordInput): Promise<void>;
}
