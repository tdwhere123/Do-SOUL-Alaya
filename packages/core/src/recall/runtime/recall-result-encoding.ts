import { MemoryDimension, MILLIGRADE_TOP, ScopeClass, indexEntryCacheKey, indexEntryObjectKind, indexMemoryObjectId, type BoundedActiveConstraintsResult, type InformationIndex } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallResult } from "./recall-service-runner.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";
import { previewTokenEstimate } from "./recall-service-helpers.js";
import { governanceManifestationCeilings, governanceManifestationFor } from "./governance-manifestation.js";

export function encodeRecallResult(
  index: InformationIndex,
  previews: ReadonlyMap<string, string> = new Map(),
  governance?: BoundedActiveConstraintsResult,
  sourceMetadata: Readonly<Record<string, RecallSourceMetadata>> = {}
): ConditionalFieldRecallResult {
  const ceilings = governanceManifestationCeilings(governance?.paths ?? []);
  const excerpts = index.entries.map((entry) => encodedPreview(previews, entry));
  const hydrated = excerpts.filter((excerpt) => excerpt !== undefined).length;
  const payload = index.entries.length === 0
    ? index.completeness.payload
    : hydrated === 0
      ? "omitted"
      : hydrated < index.entries.length
        ? "partial"
        : index.completeness.payload;
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
      token_estimate: previewTokenEstimate(excerpts[offset] ?? PAYLOAD_OMITTED_PREVIEW),
      manifestation: governance === undefined || objectId === undefined ? "excerpt" as const
        : governanceManifestationFor(objectId, ceilings,
          governance.completeness === "complete" && !governance.temporal_uncertain),
      ...candidatePlaneAttributes(kind, metadata),
      origin_plane: "workspace_local" as const,
      selection_reason: `Associated at ${entry.association_milligrades} milligrades; claim ${entry.claim}.`,
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
  if (kind === "source_evidence") {
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

const PAYLOAD_OMITTED_PREVIEW = "[payload omitted]";
