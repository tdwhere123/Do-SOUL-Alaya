import { z } from "zod";
import { AlayaError } from "@do-soul/alaya-protocol";
import { NAVIGATION_READ_LIMITS } from "./navigation-read-budget.js";
import type { NavigationSourceObservation } from "./temporal-navigation.js";

export const STRUCTURAL_NAVIGATION_METHOD = "benchmark-read-session-adjacency.v1" as const;
// One original-native first member, one successful nonempty bounded read, at most
// two immediate neighbors. No next-seed retry, inferred replies, or recursion.
export const STRUCTURAL_LIMITS = { seeds: 1, edges: 2, seed_prefix_bytes: 4096,
  ...NAVIGATION_READ_LIMITS } as const;
export const StructuralNavigationSchema = z.object({
  contract: z.literal(STRUCTURAL_NAVIGATION_METHOD),
  mode: z.enum(["off", "adjacent", "original_and_adjacent"]),
  max_source_reads: z.number().int().min(0).max(STRUCTURAL_LIMITS.source_reads).default(STRUCTURAL_LIMITS.source_reads)
}).strict();
export type StructuralNavigation = z.infer<typeof StructuralNavigationSchema>;
export type StructuralSeed = Readonly<{ record_id: string; prefix_bytes: number; body_bytes: number }>;

/** Projection consumes only fully admitted snapshot bindings. Index difference
 * exactly one prevents crossing omitted messages, even in an incomplete union.
 * Session id AND index are required; neither candidate order nor role is used. */
export function observeSessionAdjacency(sources: readonly NavigationSourceObservation[], seed: StructuralSeed | null) {
  const seedSource = seed === null ? undefined : sources.find(row => row.record_id === seed.record_id);
  const origin = seedSource && "binding" in seedSource.source_time ? seedSource.source_time.binding : undefined;
  if (seed && (!Number.isSafeInteger(seed.prefix_bytes) || seed.prefix_bytes <= 0 || seed.prefix_bytes > STRUCTURAL_LIMITS.seed_prefix_bytes ||
      seed.body_bytes < seed.prefix_bytes || seedSource === undefined)) {
    throw new AlayaError("VALIDATION", "structural seed lacks an admitted nonempty read");
  }
  const edges = sources.flatMap(source => {
    const target = "binding" in source.source_time ? source.source_time.binding : undefined;
    if (!origin || !target || source.record_id === seed?.record_id) return [];
    if (target.record_id !== source.record_id || origin.record_id !== seed?.record_id ||
        target.manifest_sha256 !== origin.manifest_sha256 || target.question_id !== origin.question_id) {
      throw new AlayaError("CONFLICT", "structural source binding mismatch");
    }
    if (target.session_id !== origin.session_id || target.session_index !== origin.session_index ||
        Math.abs(target.message_index - origin.message_index) !== 1) return [];
    return [{ from: seed!.record_id, to: source.record_id, relation: "same_session_adjacent_message" as const,
      from_binding: origin, to_binding: target }];
  }).sort((a, b) => a.to_binding.message_index - b.to_binding.message_index);
  if (edges.length > STRUCTURAL_LIMITS.edges) throw new AlayaError("CONFLICT", "ambiguous structural adjacency");
  return { method: STRUCTURAL_NAVIGATION_METHOD, status: !seed ? "unobserved" as const : !origin ? "unknown" as const : "observed" as const,
    seed, edges };
}
export type StructuralObservation = ReturnType<typeof observeSessionAdjacency>;

/** One availability meaning for the capture receipt and frozen evaluator. */
export function structuralNavigationStatus(mode: StructuralNavigation["mode"],
  nomination: "witnessed" | "measured_empty" | "unknown", observation: StructuralObservation["status"]) {
  return mode === "off" || observation === "observed" ? "complete"
    : nomination === "unknown" || observation === "unknown" ? "structure_unknown" : "structure_unobserved";
}
