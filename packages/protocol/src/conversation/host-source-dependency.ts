import { z } from "zod";
import { BoundedIdSchema } from "../shared/schema-primitives.js";
import { FieldContractDigestSchema } from "../recall/field-contract/canonical-identity.js";

/** An explicit host assertion that one message needs this contextual prerequisite.
 * It is neither factual support nor an extraction-context invalidation dependency.
 * Workspace is inherited from the containing source and cannot be redirected.
 */
export const HostSourceDependencySchema = z.object({
  source_id: BoundedIdSchema,
  root_id: BoundedIdSchema,
  source_version: BoundedIdSchema,
  content_digest: FieldContractDigestSchema,
  occurrence_id: BoundedIdSchema
}).strict().readonly();
export type HostSourceDependency = z.infer<typeof HostSourceDependencySchema>;

/** Absent means unknown; an explicit empty array records the host's known-empty assertion. */
export const HostSourceDependenciesSchema = z.array(HostSourceDependencySchema).max(32).readonly();
