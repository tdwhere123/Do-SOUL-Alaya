import {
  AlayaError,
  EvidenceTextDisclosuresSchema,
  SoulOpenPointerResponseSchema,
  sourceRecallTarget,
  type EvidenceTextDisclosures,
  type SourceEvidenceTarget,
  type SourceOpenTarget,
  type SourceRepresentation,
  type SoulOpenPointerResponse
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { projectSourceDisclosure } from "../recall/runtime/source-disclosure.js";

export type OpenSourceRootRow = Readonly<{
  readonly kind: "source_record" | "evidence_capsule";
  readonly workspace_id: string;
  readonly root_id: string;
  readonly revision: string;
  readonly digest: string;
  readonly evidence_object_id: string | null;
  readonly event_time: string | null;
  readonly content?: string;
  readonly content_start: number;
  readonly content_end: number;
  readonly content_complete: boolean;
  readonly original_complete: boolean;
  readonly retained_extent: "body" | "excerpt" | "gist";
  readonly source_representation?: SourceRepresentation;
  readonly valid_from?: string | null;
  readonly valid_to?: string | null;
}>;

export type OpenCurrentSourceTargetResult =
  | { readonly status: "ok"; readonly row: OpenSourceRootRow }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export type SourceTargetOpenPort = Readonly<{
  openCurrentSourceTarget?(
    workspaceId: string,
    target: SourceEvidenceTarget,
    byteLimit?: number,
    offset?: number
  ): OpenCurrentSourceTargetResult | Promise<OpenCurrentSourceTargetResult>;
  isCurrentTarget(
    workspaceId: string,
    target: SourceEvidenceTarget
  ): Promise<boolean> | boolean;
  hydrate?(
    workspaceId: string,
    target: SourceEvidenceTarget,
    byteLimit?: number,
    offset?: number,
    nativeByteLimit?: number
  ): Readonly<{
    readonly row: OpenSourceRootRow | null;
    readonly unavailable: boolean;
    readonly resourceLimited?: boolean;
  }> | Promise<Readonly<{
    readonly row: OpenSourceRootRow | null;
    readonly unavailable: boolean;
    readonly resourceLimited?: boolean;
  }>>;
}>;

const DEFAULT_OPEN_SOURCE_BYTE_BUDGET = 65_536;
const SOURCE_OPEN_NATIVE_RESERVATION = 32_768;

/**
 * Shared workspace-scoped owner for opening `source_target` handles via
 * `SqliteSourceRootRecallReader.hydrate` without minting a memory ID.
 */
export async function openWorkspaceSourceTarget(input: Readonly<{
  readonly reader: SourceTargetOpenPort;
  readonly workspaceId: string;
  readonly sourceTarget: SourceOpenTarget;
  readonly startOffset?: number;
  readonly byteBudget?: number;
  readonly evaluatedAsOf: string;
}>): Promise<SoulOpenPointerResponse> {
  const byteBudget = input.byteBudget ?? DEFAULT_OPEN_SOURCE_BYTE_BUDGET;
  const startOffset = input.startOffset ?? 0;
  // Workspace scope comes strictly from the trusted context, never from caller payloads.
  const scopedTarget = sourceRecallTarget({
    workspace_id: input.workspaceId,
    root_kind: input.sourceTarget.root_kind,
    root_id: input.sourceTarget.root_id,
    source_version: input.sourceTarget.source_version,
    content_digest: input.sourceTarget.content_digest,
    evidence_object_id: input.sourceTarget.evidence_object_id ?? null
  });
  const outcome = await readCurrentTarget(input.reader, input.workspaceId, scopedTarget, byteBudget, startOffset);
  if (outcome.status === "not_found") {
    throw new CoreError("NOT_FOUND", `Pointer source target not found: ${scopedTarget.root_id}`);
  }
  if (outcome.status === "conflict") {
    throw new CoreError("CONFLICT", `Pointer source target is unavailable: ${outcome.reason}`);
  }
  if (outcome.status === "unavailable") {
    throw new AlayaError("UNAVAILABLE", `Pointer source target read could not complete: ${outcome.reason}`);
  }
  if (!outcome.row.content_complete && outcome.row.content_end === startOffset) {
    throw new AlayaError("VALIDATION", "byte_budget cannot fit the UTF-8 character at start_offset.");
  }
  return buildSourceOpenPointerResponse(outcome.row, input.workspaceId, input.evaluatedAsOf);
}

async function readCurrentTarget(
  reader: SourceTargetOpenPort,
  workspaceId: string,
  target: SourceEvidenceTarget,
  byteBudget: number,
  startOffset: number
): Promise<OpenCurrentSourceTargetResult> {
  if (reader.openCurrentSourceTarget !== undefined) {
    return await reader.openCurrentSourceTarget(workspaceId, target, byteBudget, startOffset);
  }
  if (reader.hydrate === undefined) {
    throw new AlayaError("UNAVAILABLE", "Source target reader is not available.");
  }
  const current = await reader.isCurrentTarget(workspaceId, target);
  if (!current) return { status: "not_found" };
  const page = await reader.hydrate(
    workspaceId,
    target,
    byteBudget,
    startOffset,
    byteBudget + SOURCE_OPEN_NATIVE_RESERVATION
  );
  if (page.row !== null && !page.unavailable) {
    return { status: "ok", row: page.row };
  }
  if (page.resourceLimited && !page.unavailable) {
    return { status: "unavailable", reason: "resource_limited" };
  }
  return { status: "not_found" };
}

function buildSourceOpenPointerResponse(
  row: OpenSourceRootRow,
  workspaceId: string,
  evaluatedAsOf: string
): SoulOpenPointerResponse {
  const span = {
    content_start: row.content_start,
    content_end: row.content_end,
    retained_extent: row.retained_extent,
    content_complete: row.content_complete,
    original_complete: row.original_complete
  } as const;
  const target = sourceRecallTarget({
    workspace_id: workspaceId,
    root_kind: row.kind,
    root_id: row.root_id,
    source_version: row.revision,
    content_digest: row.digest,
    evidence_object_id: row.evidence_object_id,
    span
  });
  const disclosure = projectSourceDisclosure({
    material_kind: row.kind === "source_record"
      ? "original_body"
      : row.retained_extent === "gist"
        ? "retained_gist"
        : "retained_excerpt",
    evaluated_as_of: evaluatedAsOf,
    source: {
      event_time: row.event_time,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      ...(row.source_representation === undefined ? {} : { source_representation: row.source_representation })
    },
    proof_use: "source_only"
  });
  const textDisclosures = buildTextDisclosures(row, disclosure, evaluatedAsOf);
  const contentText = row.content !== undefined && row.content.length > 0 ? row.content : null;
  return SoulOpenPointerResponseSchema.parse({
    object_kind: "source_evidence",
    target,
    content: {
      object_kind: "source_evidence",
      schema_version: 1,
      content: contentText,
      domain_tags: [],
      evidence_refs: [],
      text_disclosures: textDisclosures,
      source_disclosure: disclosure,
      span
    }
  });
}

function buildTextDisclosures(
  row: OpenSourceRootRow,
  contentDisclosure: ReturnType<typeof projectSourceDisclosure>,
  evaluatedAsOf: string
): EvidenceTextDisclosures {
  const gistDisclosure = row.kind === "evidence_capsule" && row.retained_extent === "gist"
    ? contentDisclosure
    : projectSourceDisclosure({ material_kind: "retained_gist", evaluated_as_of: evaluatedAsOf });
  return EvidenceTextDisclosuresSchema.parse({
    content: contentDisclosure,
    gist: gistDisclosure,
    ...(row.kind === "evidence_capsule" && row.retained_extent === "excerpt"
      ? { excerpt: contentDisclosure }
      : {})
  });
}
