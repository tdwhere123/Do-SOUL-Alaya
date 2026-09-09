import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  MemoryDimension,
  RecallCandidateSchema,
  ScopeClass,
  indexEntryCacheKey,
  type IndexEntry,
  type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import { hydrateUtf8Chunk } from "../../../../memory/evidence-create/source-utf8-hydrate.js";
import {
  applyUtf8HydrateToSourceRootPage,
  captureIndexPreviews,
  captureIndexSourceMetadata,
  encodeRecallResult,
  runConditionalFieldRecall,
  type ObserverReaders
} from "../../../../recall/recall-service.js";
import { BoundedIndexPayload } from "../../../../recall/runtime/index-payload.js";
import {
  FAR_FUTURE_EXPIRY,
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget
} from "../reference/deployment.fixture.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SOURCE_TARGET: SourceEvidenceTarget = {
  kind: "source_evidence",
  workspace_id: "workspace",
  root_kind: "source_record",
  root_id: "rec-1",
  source_version: "v1",
  content_digest: DIGEST,
  evidence_object_id: null
};
const OVERSIZED_BODY = `needle ${"汉".repeat(80)}`;

describe("source payload encode", () => {
  it("encodes source_evidence without FACT/PROJECT defaults", () => {
    const entry = sourceEntry();
    const encoded = encodeRecallResult(
      sourceIndex([entry]),
      new Map([[indexEntryCacheKey(entry), "quoted excerpt"]])
    );
    const candidate = RecallCandidateSchema.parse(encoded.candidates[0]);
    expect(candidate.object_kind).toBe("source_evidence");
    expect(candidate.dimension).toBeUndefined();
    expect(candidate.scope_class).toBeUndefined();
    const withScope = encodeRecallResult(
      sourceIndex([entry]),
      new Map([[indexEntryCacheKey(entry), "quoted excerpt"]]),
      undefined,
      { [indexEntryCacheKey(entry)]: { scope_class: ScopeClass.PROJECT } }
    );
    expect(withScope.candidates[0]?.dimension).toBeUndefined();
    expect(withScope.candidates[0]?.scope_class).toBe(ScopeClass.PROJECT);
    const memory = encodeRecallResult(sourceIndex([memoryEntry()]), new Map([["memory", "body"]]));
    expect(memory.candidates[0]?.dimension).toBe(MemoryDimension.FACT);
    expect(memory.candidates[0]?.scope_class).toBe(ScopeClass.PROJECT);
  });

  it("hydrates the next UTF-8 chunk from payload_continuation after an incomplete first page", () => {
    const firstChunk = hydrateUtf8Chunk(OVERSIZED_BODY, { offset: 0, byteLimit: 32 });
    expect(firstChunk.status).toBe("chunk");
    if (firstChunk.status !== "chunk") return;
    expect(firstChunk.complete).toBe(false);
    const firstCalls: HydrateCall[] = [];
    const first = new BoundedIndexPayload({
      readers: hydrateReaders(firstCalls),
      workspaceId: "workspace",
      remainingMemoryBytes: 32,
      manifestationFor: () => "excerpt"
    });
    const firstPage = first.finalize([sourceEntry()], 20);
    expect(firstPage.complete).toBe(false);
    expect(firstPage.retryable).toBe(true);
    expect(firstCalls[0]).toEqual({ offset: 0, byteLimit: 32 });
    expect([...first.previews.values()][0]).toBe(firstChunk.text);

    const nextCalls: HydrateCall[] = [];
    const continued = new BoundedIndexPayload({
      readers: hydrateReaders(nextCalls),
      workspaceId: "workspace",
      remainingMemoryBytes: 32,
      manifestationFor: () => "excerpt",
      payloadContinuation: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        purpose: "payload_expansion",
        target: SOURCE_TARGET,
        start_offset: firstChunk.next_offset ?? firstChunk.end_offset,
        byte_budget: 32
      }
    });
    const secondPage = continued.finalize([sourceEntry()], 20);
    const secondChunk = hydrateUtf8Chunk(OVERSIZED_BODY, {
      offset: firstChunk.end_offset,
      byteLimit: 32
    });
    expect(secondChunk.status).toBe("chunk");
    if (secondChunk.status !== "chunk") return;
    expect(nextCalls[0]).toEqual({ offset: firstChunk.end_offset, byteLimit: 32 });
    expect([...continued.previews.values()][0]).toBe(secondChunk.text);
    expect(secondPage.retryable).toBe(!secondChunk.complete);
    const firstDelivered = first.applyDeliveredSpans(sourceIndex([sourceEntry()]));
    const secondDelivered = continued.applyDeliveredSpans(sourceIndex([sourceEntry()]));
    const firstTarget = firstDelivered.entries[0]?.target;
    const secondTarget = secondDelivered.entries[0]?.target;
    expect(firstTarget?.kind).toBe("source_evidence");
    expect(secondTarget?.kind).toBe("source_evidence");
    if (firstTarget?.kind !== "source_evidence" || secondTarget?.kind !== "source_evidence") return;
    expect(firstTarget.span).toEqual({
      content_start: 0,
      content_end: firstChunk.end_offset,
      retained_extent: "body",
      content_complete: false,
      original_complete: true
    });
    expect(secondTarget.span?.content_start).toBe(firstChunk.end_offset);
    expect(secondTarget.span?.content_end).toBe(secondChunk.end_offset);
    expect(firstTarget).not.toEqual(secondTarget);
  });

  it("threads payload_continuation offset through source-only Recall hydrate", () => {
    const firstChunk = hydrateUtf8Chunk(OVERSIZED_BODY, { offset: 0, byteLimit: 32 });
    expect(firstChunk.status).toBe("chunk");
    if (firstChunk.status !== "chunk") return;
    const startOffset = firstChunk.end_offset;
    const calls: HydrateCall[] = [];
    const index = runConditionalFieldRecall({
      workspace_id: "workspace",
      query_text: "needle",
      budget: defaultBudget(),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: FAR_FUTURE_EXPIRY,
      result_kind_view: "source_only",
      payload_continuation: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        purpose: "payload_expansion",
        target: SOURCE_TARGET,
        start_offset: startOffset,
        byte_budget: 16
      },
      readers: {
        sourceRoots: () => ({
          rows: [{
            kind: "source_record",
            workspace_id: "workspace",
            root_id: "rec-1",
            revision: "v1",
            digest: DIGEST,
            evidence_object_id: null,
            content: OVERSIZED_BODY,
            content_complete: false
          }],
          nativeVisits: 1,
          nativeBytes: 20,
          rowsRead: 1,
          bytesRead: 20,
          truncated: false
        }),
        sourceRoot: hydrateReaders(calls).sourceRoot
      }
    });
    const sourceEntryOnIndex = index.entries.find((entry) => entry.target.kind === "source_evidence");
    expect(sourceEntryOnIndex?.target.kind).toBe("source_evidence");
    if (sourceEntryOnIndex?.target.kind !== "source_evidence") return;
    expect(calls.some((call) => call.offset === startOffset && call.byteLimit === 16)).toBe(true);
    expect(sourceEntryOnIndex.target.span?.content_start).toBe(startOffset);
    const encoded = encodeRecallResult(
      index,
      captureIndexPreviews(index, {}, "workspace"),
      undefined,
      captureIndexSourceMetadata(index)
    );
    const source = encoded.candidates.find((candidate) => candidate.object_kind === "source_evidence");
    expect(source?.dimension).toBeUndefined();
    expect(source?.scope_class).toBeUndefined();
  });
});

type HydrateCall = Readonly<{ readonly offset?: number; readonly byteLimit?: number }>;

function sourceEntry(): IndexEntry {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: SOURCE_TARGET,
    hypothesis_id: "h0",
    output_binding: "default",
    role: "requested",
    association_milligrades: 1000,
    claim: "unknown",
    explanation_ids: []
  };
}

function memoryEntry(): IndexEntry {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: {
      kind: "memory_entry",
      workspace_id: "workspace",
      object_id: "memory",
      source_revision: "rev"
    },
    object_id: "memory",
    hypothesis_id: "h0",
    output_binding: "default",
    role: "requested",
    association_milligrades: 1000,
    claim: "unknown",
    explanation_ids: []
  };
}

function sourceIndex(entries: readonly IndexEntry[]) {
  return InformationIndexSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "source-payload",
    snapshot_id: SNAPSHOT_ID,
    result_version: "v1",
    entries,
    completeness: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      logical_index: "complete",
      observed_coverage: "complete",
      transport: "complete",
      payload: "complete",
      representation: "complete"
    },
    continuation: null,
    representation: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      policy: "construct_index_then_page_then_payload",
      page_budget: 30,
      identity_tie_break: "serialization"
    }
  });
}

function hydrateReaders(calls: HydrateCall[]): Required<Pick<ObserverReaders, "sourceRoot">> {
  return {
    sourceRoot: (input) => {
      calls.push({ offset: input.offset, byteLimit: input.byteLimit });
      return applyUtf8HydrateToSourceRootPage({
        row: {
          kind: "source_record",
          workspace_id: "workspace",
          root_id: "rec-1",
          revision: "v1",
          digest: DIGEST,
          evidence_object_id: null,
          content: OVERSIZED_BODY
        },
        rowsRead: 1,
        bytesRead: Buffer.byteLength(OVERSIZED_BODY, "utf8"),
        unavailable: false
      }, input.offset ?? 0, input.byteLimit ?? 65536);
    }
  };
}
