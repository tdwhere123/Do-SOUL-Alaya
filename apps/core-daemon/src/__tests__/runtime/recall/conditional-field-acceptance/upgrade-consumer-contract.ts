import {
  InformationIndexSchema,
  type IndexEntry,
  type InformationIndex,
  type MemorySearchResult
} from "@do-soul/alaya-protocol";
import { CONTRACT_ONLY_UNTIL_REAL_PRODUCERS } from "./consumer-contract.js";

export { CONTRACT_ONLY_UNTIL_REAL_PRODUCERS };

export const PAYLOAD_OMITTED_PREVIEW = "[payload omitted]";

export function productIdentity(entry: Pick<IndexEntry, "object_id" | "hypothesis_id" | "output_binding" | "program_state" | "time_state">): string {
  return [
    entry.object_id,
    entry.hypothesis_id,
    entry.output_binding,
    entry.program_state ?? "",
    entry.time_state ?? ""
  ].join("\0");
}

export function assertIndexPreservesProductIdentity(index: InformationIndex): readonly string[] {
  const failures: string[] = [];
  InformationIndexSchema.parse(index);
  for (const entry of index.entries) {
    if (entry.program_state === undefined) failures.push(`missing program_state on ${entry.object_id}`);
    if (entry.time_state === undefined) failures.push(`missing time_state on ${entry.object_id}`);
  }
  const identities = index.entries.map(productIdentity);
  if (new Set(identities).size !== identities.length) {
    failures.push("object-only identity collapsed distinct product states");
  }
  return failures;
}

export function assertInterpretationCoverageHonest(index: InformationIndex): readonly string[] {
  const failures: string[] = [];
  const coverage = index.completeness.interpretation_coverage;
  if (coverage === undefined) {
    failures.push("interpretation_coverage omitted from public completeness");
    return failures;
  }
  if (coverage === "complete" && index.completeness.observed_coverage === "complete") {
    return failures;
  }
  if (coverage === "complete" && index.completeness.logical_index !== "complete") {
    failures.push("interpretation_coverage complete while logical index is not");
  }
  return failures;
}

export function assertResultsDoNotReselect(
  results: readonly Pick<MemorySearchResult, "object_id">[],
  index: InformationIndex
): readonly string[] {
  const failures: string[] = [];
  const resultIds = results.map((row) => row.object_id);
  const indexIds = index.entries.map((entry) => entry.object_id);
  if (resultIds.join("|") !== indexIds.join("|")) {
    failures.push("consumer results reselected away from index order");
  }
  return failures;
}

export function assertPreviewIsSourceExcerpt(
  preview: string,
  sourceExcerpt: string
): readonly string[] {
  const failures: string[] = [];
  if (preview === PAYLOAD_OMITTED_PREVIEW) {
    failures.push("worker-port residual omitted the pinned source excerpt");
  }
  if (!preview.includes(sourceExcerpt) && preview !== sourceExcerpt) {
    failures.push("preview is not the pinned source excerpt");
  }
  return failures;
}

export function plantedEmptyPreview(preview: string): boolean {
  return preview === PAYLOAD_OMITTED_PREVIEW;
}

export function plantedFlattenedResultsDropIdentity(
  results: readonly Record<string, unknown>[]
): boolean {
  return results.some((row) => !("program_state" in row) || !("time_state" in row));
}

export function assertNoRetiredSelectorKeys(payload: object): readonly string[] {
  const failures: string[] = [];
  const encoded = payload as Record<string, unknown>;
  for (const key of ["ranking_authority", "delivery_path"] as const) {
    if (key in encoded) failures.push(`retired consumer key ${key}`);
  }
  return failures;
}

export function physicalDeletionIsOutOfBand(claim: "exclusivity" | "physical_absence"): boolean {
  return claim === "physical_absence";
}
