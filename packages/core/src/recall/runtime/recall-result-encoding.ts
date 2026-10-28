import { qualifySourceDisclosure, MemoryDimension, MILLIGRADE_TOP, ScopeClass, indexEntryCacheKey, indexEntryObjectKind, indexMemoryObjectId, type BoundedActiveConstraintsResult, type InformationIndex } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallResult } from "./recall-service-runner.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";
import { previewTokenEstimate } from "./recall-service-helpers.js";
import { governanceManifestationCeilings, governanceManifestationFor } from "./governance-manifestation.js";
import { projectSourceDisclosure } from "./source-disclosure.js";
import { CoreError } from "../../shared/errors.js";

export function encodeRecallResult(
  index: InformationIndex,
  previews: ReadonlyMap<string, string> = new Map(),
  governance?: BoundedActiveConstraintsResult,
  sourceMetadata: Readonly<Record<string, RecallSourceMetadata>> = {}
): ConditionalFieldRecallResult {
  const ceilings = governanceManifestationCeilings(governance?.paths ?? []);
  const excerpts = index.entries.map((entry) => {
    const preview = encodedPreview(previews, entry);
    // The public preview is a display field. Preserve a hydrated empty source
    // distinctly from unavailable payload without altering stored source bytes.
    return displayRecallPreview(preview, entry.target);
  });
  const hydrated = excerpts.filter((excerpt) => excerpt !== undefined).length;
  const payload = projectPayloadCompleteness(index.completeness.payload,
    index.entries.length > 0 && hydrated === 0, hydrated < index.entries.length);
  const encodedIndex: InformationIndex = payload === index.completeness.payload
    ? index
    : {
      ...index,
      completeness: { ...index.completeness, payload }
    };
  const candidates = encodedIndex.entries.map((entry, offset) => {
    const score = entry.association_milligrades / MILLIGRADE_TOP;
    const objectId = indexMemoryObjectId(entry);
    const cacheKey = indexEntryCacheKey(entry);
    const metadata = sourceMetadata[cacheKey] ?? (objectId === undefined ? undefined : sourceMetadata[objectId]);
    const kind = indexEntryObjectKind(entry);
    return {
      ...(objectId === undefined ? {} : { object_id: objectId }),
      object_kind: kind,
      target: entry.target,
      activation_score: score,
      relevance_score: score,
      content_preview: excerpts[offset] ?? PAYLOAD_OMITTED_PREVIEW,
      payload_available: excerpts[offset] !== undefined,
      ...(entry.target.kind !== "source_evidence" ? {} : { source_disclosure: kind === "semantic_proof"
        ? qualifySourceDisclosure(metadata?.source_disclosure ?? projectSourceDisclosure({
          material_kind: entry.target.root_kind === "source_record" ? "original_body"
            : entry.target.span?.retained_extent === "gist" ? "retained_gist" : "retained_excerpt",
          evaluated_as_of: sourceClock(encodedIndex)
        }), "conditional_support")
        : metadata?.source_disclosure ?? projectSourceDisclosure({
          material_kind: entry.target.root_kind === "source_record" ? "original_body"
            : entry.target.span?.retained_extent === "gist" ? "retained_gist" : "retained_excerpt",
          evaluated_as_of: sourceClock(encodedIndex)
        }) }),
      token_estimate: previewTokenEstimate(excerpts[offset] ?? PAYLOAD_OMITTED_PREVIEW),
      manifestation: governance === undefined || objectId === undefined ? "excerpt" as const
        : governanceManifestationFor(objectId, ceilings,
          governance.completeness === "complete" && !governance.temporal_uncertain),
      ...candidatePlaneAttributes(kind, metadata),
      origin_plane: "workspace_local" as const,
      selection_reason: `Associated at ${entry.association_milligrades} milligrades; claim ${entry.claim}.`,
      ...(metadata?.source_lookup_reasons === undefined ? {} : { source_lookup_reasons: metadata.source_lookup_reasons }),
      ...(metadata?.staged_warnings === undefined ? {} : {
        staged_warnings: metadata.staged_warnings
      })
    };
  });
  return {
    candidates,
    source_metadata: sourceMetadata,
    synthesis: { status: "absent" },
    active_constraints: governance?.constraints ?? [],
    active_constraints_count: governance?.total_count ?? null,
    active_constraints_completeness: governance?.completeness ?? "incomplete",
    total_scanned: encodedIndex.entries.length,
    coarse_filter_count: encodedIndex.entries.length,
    fine_assessment_count: encodedIndex.entries.length,
    degradation_reason: null,
    working_projection: null,
    index: encodedIndex,
    provider_calls: 0,
    garden_enqueue: 0
  };
}

function sourceClock(index: InformationIndex): string {
  const clock = index.as_of ?? index.continuation?.interpretation_clock;
  if (clock === undefined) throw new CoreError("OBLIGATION_VIOLATION", "source disclosure requires an evaluation clock");
  return clock;
}

function encodedPreview(
  previews: ReadonlyMap<string, string>,
  entry: InformationIndex["entries"][number]
): string | undefined {
  const cacheKey = indexEntryCacheKey(entry);
  const hit = previews.get(cacheKey);
  if (hit !== undefined) return hit;
  if (entry.target.kind === "memory_entry") return undefined;
  const objectId = indexMemoryObjectId(entry);
  return objectId === undefined ? undefined : previews.get(objectId);
}

function candidatePlaneAttributes(
  kind: ReturnType<typeof indexEntryObjectKind>,
  metadata: RecallSourceMetadata | undefined
): Pick<RecallSourceMetadata, "dimension" | "scope_class"> {
  if (kind === "source_evidence" || kind === "semantic_proof") {
    return {
      ...(metadata?.dimension === undefined ? {} : { dimension: metadata.dimension }),
      ...(metadata?.scope_class === undefined ? {} : { scope_class: metadata.scope_class })
    };
  }
  return {
    dimension: metadata?.dimension ?? MemoryDimension.FACT,
    scope_class: metadata?.scope_class ?? ScopeClass.PROJECT
  };
}

export const PAYLOAD_OMITTED_PREVIEW = "[payload omitted]";

/** Display decoration, never source bytes or evidence of a nonempty span. */
export function displayRecallPreview(preview: string | undefined,
  target: InformationIndex["entries"][number]["target"]): string | undefined {
  return target.kind === "source_evidence" && preview === "" ? "[empty source]" : preview;
}

/** Encoding can reduce delivered completeness, not erase an explicit execution
 * failure, unknown state or interruption. Both service and wire adapters use this. */
export function projectPayloadCompleteness(status: InformationIndex["completeness"]["payload"],
  omitted: boolean, partial: boolean): InformationIndex["completeness"]["payload"] {
  if (status !== "complete" && status !== "partial") return status;
  return omitted ? "omitted" : partial ? "partial" : status;
}
