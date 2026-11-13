import { z } from "zod";
import { HostSourceDependencySchema } from "./host-source-dependency.js";
import { BoundedIdSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";

const Span = z.tuple([NonNegativeIntSchema, NonNegativeIntSchema]).readonly();
export const HOST_DEPENDENCY_EXPOSURE_LIMIT = 256;
/** Literal contextual prerequisites, not proof of an answer or semantic sufficiency.
 * `complete` means every explicitly recorded reachable prerequisite's complete bytes
 * occur in this encoded response, with no unknown outgoing dependency declaration.
 */
export const HostDependencyExposureSchema = z.object({
  status: z.enum(["complete", "partial", "unknown"]),
  roots: z.array(z.object({ occurrence_id: BoundedIdSchema, utf8_span: Span,
    previously_delivered: z.literal(true).optional(),
    dependencies: z.array(HostSourceDependencySchema).max(32).readonly().optional()
  }).strict().readonly()).max(256).readonly(),
  prerequisites: z.array(z.object({
    reference: HostSourceDependencySchema.optional(),
    status: z.enum(["delivered", "partial", "unavailable", "denied", "invalid", "resource_limited", "cycle", "omitted"]),
    utf8_span: Span.optional(),
    content_span: Span.optional(),
    content: z.string().optional(),
    next_offset: NonNegativeIntSchema.optional(),
    dependencies: z.array(HostSourceDependencySchema).max(32).readonly().optional()
  }).strict().readonly()).max(HOST_DEPENDENCY_EXPOSURE_LIMIT).readonly()
}).strict().readonly();
export type HostDependencyExposure = z.infer<typeof HostDependencyExposureSchema>;
