import { z } from "zod";
import { AlayaError, SourceIndexConfigurationSchema, SourceIndexGenerationStatusSchema,
  SourceIndexTargetSchema, SourceSemanticAcquisitionSchema } from "@do-soul/alaya-protocol";
import { SqliteSourceIndexRepository } from "@do-soul/alaya-storage";

type Constructor = typeof SqliteSourceIndexRepository;
type Measurement = Constructor[Extract<keyof Constructor, symbol>];
const key = Symbol.for("@do-soul/alaya-storage/private/source-index-measurement");

/** Private friend of the existing storage constructor, not a source/dist deep import.
 * Storage owns native facts; this adapter owns diagnostic transport validation only.
 * An older installed storage package leaves diagnostics unavailable, not ordinary recall. */
function owner(): Measurement {
  const value: unknown = Reflect.get(SqliteSourceIndexRepository, key);
  if (value === undefined) throw new AlayaError("CONFLICT", "private source-index measurement capability unavailable");
  return value as Measurement;
}
export type SourceIndexSnapshotFact = ReturnType<Measurement["readSnapshot"]>;
export type SourceIndexRootQualification = ReturnType<Measurement["readRoot"]>;
const Count = z.number().int().nonnegative();
const Selection = z.object({ workspace_id: z.string(), selection_revision: Count, config_id: z.string(),
  profile_id: z.string(), configuration: SourceIndexConfigurationSchema }).strict();
export const SourceIndexSnapshotFactSchema: z.ZodType<SourceIndexSnapshotFact> = z.object({
  workspace_id: z.string(), source_epoch: Count,
  query_state: SourceSemanticAcquisitionSchema.unwrap().shape.vector.unwrap().shape.state.unwrap(),
  selection: Selection.nullable(), generation: z.object({ selection: Selection, generation_id: z.string(), source_epoch: Count,
    status: SourceIndexGenerationStatusSchema, enumeration_complete: z.boolean(), after_source_id: z.string().nullable(),
    target_count: Count, completed_count: Count, reason: z.string().nullable(),
    preparation_revision: Count, records_complete: z.boolean(), after_capsule_cursor: z.string().nullable() }).strict().nullable()
}).strict();
const Status = z.lazy(() => {
  try { return z.enum(owner().statuses); } catch { return z.never(); }
});
export const SourceIndexRootQualificationSchema: z.ZodType<SourceIndexRootQualification> = z.object({
  snapshot: SourceIndexSnapshotFactSchema, source_id: z.string(), source: SourceIndexTargetSchema.nullable(),
  status: Status, reason: z.string().nullable(), currentness: z.enum(["ready", "stale", "partial", "unknown"]),
  lexical: z.object({ status: Status, start_byte: Count.nullable(), end_byte: Count.nullable() }).strict(),
  vector: z.object({ status: Status, generation_member: z.boolean().nullable(), expected_windows: Count.nullable(),
    coverage_complete: z.boolean().nullable(), windows: z.array(z.object({ window_id: z.string(), ordinal: Count,
      start_byte: Count, end_byte: Count, content_digest: z.string(), status: Status, reason: z.string().nullable() }).strict()),
    capture: z.enum(["complete", "partial", "unknown"]), next_ordinal: Count.nullable() }).strict()
}).strict();
export function readSourceIndexSnapshotFact(...args: Parameters<Measurement["readSnapshot"]>): SourceIndexSnapshotFact {
  return owner().readSnapshot(...args);
}
export function readSourceIndexRootQualification(...args: Parameters<Measurement["readRoot"]>): SourceIndexRootQualification {
  return owner().readRoot(...args);
}
