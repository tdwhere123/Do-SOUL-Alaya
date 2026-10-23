import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { AlayaError, SourceIndexConfigurationSchema } from "@do-soul/alaya-protocol";
import { NAVIGATION_CONTRACT, NAVIGATION_LIMITS } from "./conditional-navigation.js";
import { FormationCaptureSchema } from "./input-condition-formation.js";
import { FieldDeliverySchema } from "./field-delivery.js";
import { ObservationWindowSchema, TEMPORAL_NAVIGATION_DOMAIN } from "./temporal-navigation.js";
import { StructuralNavigationSchema } from "./structural-navigation.js";

const Condition = z.object({ id: z.string().min(1), object: z.string().min(1), hypothesis: z.string().min(1),
  query: z.string().min(1).max(16384), status: z.enum(["ready", "partial", "unknown", "unsupported", "rejected"]),
  residual: z.string().nullable(), provenance: z.string().min(1), observation_window: ObservationWindowSchema.optional() }).strict();
const Binding = z.object({ configuration: SourceIndexConfigurationSchema, config_id: z.string(), profile_id: z.string(),
  selection_revision: z.number().int(), generation_id: z.string(), source_epoch: z.number().int(),
  status: z.enum(["ready", "valid_empty"]), enumeration_complete: z.literal(true),
  target_count: z.number().int(), completed_count: z.number().int() }).strict();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** Named compatibility consumer: the original conditional-navigation pilot family.
 * Remove this adapter when its delivery-only comparison is terminated or replaced;
 * it is not a general historical runtime admission or a producer rerun. */
export const FrozenNominationsSchema = z.object({ family: z.literal("conditional-navigation-pilot.v1"),
  receipt: z.object({ path: z.string().min(1), sha256: Sha256 }).strict(),
  byte_budget: FieldDeliverySchema.shape.byte_budget }).strict();
export const ConditionalNavigationRunSchema = z.object({
  contract: z.literal(NAVIGATION_CONTRACT), source_revision: z.string().min(1),
  cache_root: z.string().min(1), model_id: z.string().min(1).optional(), channels: z.enum(["dual", "lexical"]).default("dual"),
  frozen_nominations: FrozenNominationsSchema.optional(),
  comparison: z.object({ model: z.array(z.object({ ordinal: z.number().int().min(1).max(8), capture: FormationCaptureSchema }).strict()).max(8) }).strict().optional(),
  rows: z.array(z.object({ ordinal: z.number().int().min(1).max(8), question_id: z.string().min(1),
    snapshot: z.string().min(1), snapshot_sha256: Sha256, workspace: z.string().min(1),
    source_records: z.object({ snapshot: z.string().min(1), manifest_sha256: Sha256 }).strict().optional(),
    observation_domain: z.literal(TEMPORAL_NAVIGATION_DOMAIN).optional(),
    structural_navigation: StructuralNavigationSchema.optional(), delivery_policy: FieldDeliverySchema.optional(),
    interpretation_clock: z.string().datetime(), authorized_scopes: z.array(z.string()).nullable(),
    expected_index: Binding.nullable(), original: z.string().min(1), conditions: z.array(Condition).min(1).max(1 + NAVIGATION_LIMITS.additional_conditions),
    branches: z.array(z.array(z.string()).min(1).max(NAVIGATION_LIMITS.additional_conditions)).max(NAVIGATION_LIMITS.branches) }).strict()).min(1).max(8)
}).strict();
export type NavigationRun = z.infer<typeof ConditionalNavigationRunSchema>;
export type RunRow = NavigationRun["rows"][number];
export const FROZEN_DELIVERY_ARMS = ["window-prefix", "window-native-anchor"] as const;
export function frozenDeliveryPolicy(config: NavigationRun, arm: string) {
  if (!config.frozen_nominations || !FROZEN_DELIVERY_ARMS.some(name => name === arm)) throw new AlayaError("VALIDATION", "unknown frozen delivery policy");
  return FieldDeliverySchema.parse({ contract: "benchmark-field-delivery.v1", selection: "field-order",
    windows: arm === "window-prefix" ? "prefix" : "native-anchor", byte_budget: config.frozen_nominations.byte_budget });
}
export function navigationFileDigest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
