import { z } from "zod";
import { AlayaError } from "@do-soul/alaya-protocol";
import type { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import type { NavigationSourceObservation } from "./temporal-navigation.js";

export const STRUCTURAL_NAVIGATION_METHOD = "benchmark-read-session-adjacency.v1" as const;
export const NAVIGATION_SOURCE_READ_ALLOWANCE = { work_units: 100_000, native_bytes: 128 * 1024 } as const;
// One original-native first member, one successful nonempty bounded read, at most
// two immediate neighbors. No next-seed retry, inferred replies, or recursion.
export const STRUCTURAL_LIMITS = { seeds: 1, edges: 2, seed_prefix_bytes: 4096,
  source_reads: 522, requested_prefix_bytes: 512 + 10 * 4096,
  work_units: 522 * NAVIGATION_SOURCE_READ_ALLOWANCE.work_units,
  native_bytes: 522 * NAVIGATION_SOURCE_READ_ALLOWANCE.native_bytes } as const;
export const StructuralNavigationSchema = z.object({
  contract: z.literal(STRUCTURAL_NAVIGATION_METHOD),
  mode: z.enum(["off", "adjacent", "original_and_adjacent"]),
  max_source_reads: z.number().int().min(0).max(STRUCTURAL_LIMITS.source_reads).default(STRUCTURAL_LIMITS.source_reads)
}).strict();
export type StructuralNavigation = z.infer<typeof StructuralNavigationSchema>;
export type ReadAccounting = { status: "complete" | "partial"; source_reads: number; requested_prefix_bytes: number;
  native_bytes: number; metadata_bytes: number; dependency_work: number; unmetered_reads: number };
export const navigationReadAccounting = (): ReadAccounting => ({ status: "complete", source_reads: 0,
  requested_prefix_bytes: 0, native_bytes: 0, metadata_bytes: 0, dependency_work: 0, unmetered_reads: 0 });
export function structuralReadLedger(config: StructuralNavigation) {
  return { allowance: { ...STRUCTURAL_LIMITS, source_reads: config.max_source_reads }, accounting: navigationReadAccounting(),
    reserved: { work_units: 0, native_bytes: 0 }, reused_delivery_reads: 0 };
}
export type StructuralReadLedger = ReturnType<typeof structuralReadLedger>;

/** Shared stopped-read accounting: reserve before invoking Storage, retain known
 * meters on rejection, and never represent a thrown/null meter as zero work. */
export function readNavigationSource(records: SqliteFieldSourceRecordRepo, workspace: string, recordId: string,
  prefixBytes: number, accounting: ReadAccounting, ledger?: StructuralReadLedger) {
  const { work_units: work, native_bytes: bytes } = NAVIGATION_SOURCE_READ_ALLOWANCE;
  if (ledger && (ledger.accounting.source_reads >= ledger.allowance.source_reads ||
      ledger.accounting.requested_prefix_bytes + prefixBytes > ledger.allowance.requested_prefix_bytes ||
      ledger.reserved.work_units + work > ledger.allowance.work_units ||
      ledger.reserved.native_bytes + bytes > ledger.allowance.native_bytes)) {
    throw new AlayaError("UNAVAILABLE", "shared navigation read allowance exhausted");
  }
  if (ledger) { ledger.reserved.work_units += work; ledger.reserved.native_bytes += bytes; }
  const accounts = [...new Set([accounting, ...(ledger ? [ledger.accounting] : [])])];
  for (const account of accounts) {
    account.source_reads++; account.requested_prefix_bytes += prefixBytes; account.unmetered_reads++; account.status = "partial";
  }
  try {
    const read = records.findByIdBounded(workspace, recordId, prefixBytes, 0, { workLimit: work, nativeByteLimit: bytes });
    if (read !== null) for (const account of accounts) {
      account.unmetered_reads--; account.native_bytes += read.nativeBytes;
      account.metadata_bytes += read.metadataBytes; account.dependency_work += read.dependencyWork;
    }
    return read;
  } finally {
    for (const account of accounts) account.status = account.unmetered_reads === 0 ? "complete" : "partial";
  }
}
export type NavigationSourceRead = ReturnType<typeof readNavigationSource>;
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
