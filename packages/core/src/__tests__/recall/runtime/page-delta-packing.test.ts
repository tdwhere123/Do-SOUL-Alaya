import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ORDINARY_NATIVE_FIELD_RESULT_VERSION,
  SoulMemorySearchResponseSchema,
  SoulMemorySearchResponseWireSchema,
  sourceDisclosure,
  sourceGoldRootIdentity,
  sourceRecallTarget,
  type HostDependencyExposure,
  type SourceDeliveryBoundaries
} from "@do-soul/alaya-protocol";
import { BoundedIndexPayload } from "../../../recall/runtime/index-payload.js";
import {
  captureIndexPreviews,
  captureIndexSourceMetadata
} from "../../../recall/runtime/recall-index-commit.js";
import {
  encodeIndexResults,
  encodeRecallPageResponse,
  frameEncodedIndex
} from "../../../recall/runtime/recall-page-encoding.js";
import { runConditionalFieldRecallWithReceipt } from "../../../recall/runtime/recall-service-runner.js";
import type { ConditionalFieldRecallRequest } from "../../../recall/runtime/recall-service-runner-types.js";
import { capableRecallConsumerDeclaration } from "../../../recall/runtime/recall-consumer-compatibility.js";
import type { ObserverReaders, SourceRootHydrateObserverPage } from "../../../recall/conditional-field/observers/observe-ports.js";
import { defaultBudget, FAR_FUTURE_EXPIRY } from "../conditional-field/reference/deployment.fixture.js";

const CLOCK = "2026-09-25T10:00:00.000Z";
const WS = "workspace-delta";

function sha(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

type MockRoot = Readonly<{
  id: string;
  body: string;
  messages: readonly number[];
  omitPayload?: boolean;
  dependency?: (span: readonly [number, number]) => HostDependencyExposure;
}>;

function makeReaders(roots: readonly MockRoot[], options?: Readonly<{
  payloadRange?: ObserverReaders["sourceRootPayloadRange"];
}>): ObserverReaders {
  const byId = new Map(roots.map(root => [root.id, root]));
  const admittedRoots = roots.map(root => sourceRecallTarget({
    workspace_id: WS,
    root_kind: "source_record",
    root_id: root.id,
    source_version: "1",
    content_digest: sha(root.body),
    evidence_object_id: null
  }));
  return {
    nominateSources: () => ({
      result: null,
      witness: [],
      admitted_roots: admittedRoots,
      catalog_positions: Object.fromEntries(admittedRoots.map((root, idx) => [sourceGoldRootIdentity(root), idx]))
    }),
    sourceRootPayloadRange: options?.payloadRange,
    sourceRoot: (input): SourceRootHydrateObserverPage => {
      const root = byId.get(input.rootId);
      if (root === undefined) return { row: null, rowsRead: 1, bytesRead: 0, unavailable: true };
      if (input.purpose === "payload" && root.omitPayload === true) {
        return { row: null, rowsRead: 1, bytesRead: 0, unavailable: true };
      }
      const buf = Buffer.from(root.body, "utf8");
      const offset = input.offset ?? 0;
      const byteLimit = input.byteLimit ?? 65_536;
      const sliceEnd = Math.min(buf.length, offset + byteLimit);
      const chunk = buf.subarray(offset, sliceEnd).toString("utf8");
      const complete = sliceEnd >= buf.length;
      const inWindowSpans = root.messages
        .filter(end => end > offset && end <= sliceEnd)
        .map(end => ({ purpose: "message" as const, end_offset: end }));
      const firstBeyond = root.messages.find(end => end > sliceEnd);
      const boundaries: SourceDeliveryBoundaries = {
        status: "available",
        spans: inWindowSpans,
        ...(inWindowSpans.length === 0 && firstBeyond !== undefined ? { first_end_offset: firstBeyond } : {})
      };
      return {
        row: {
          kind: "source_record",
          workspace_id: WS,
          root_id: root.id,
          revision: "1",
          digest: sha(root.body),
          evidence_object_id: null,
          ...(root.omitPayload === true ? {} : { content: chunk }),
          content_start: offset,
          content_end: sliceEnd,
          content_complete: complete,
          original_complete: true,
          retained_extent: "body",
          source_representation: { kind: "original_body" },
          scope_class: "project",
          delivery_boundaries: boundaries,
          valid_from: "2026-09-25T00:00:00.000Z",
          valid_to: "2026-09-26T00:00:00.000Z"
        },
        rowsRead: 1,
        bytesRead: Buffer.byteLength(chunk, "utf8"),
        metadataBytes: 64,
        nativeWork: 1,
        unavailable: false,
        resourceLimited: !complete
      };
    },
    ...(roots.some(root => root.dependency !== undefined) ? {
      sourceDependencies: input => {
        const root = byId.get(input.target.root_id);
        const exposure = root?.dependency?.(input.span) ?? {
          status: "unknown",
          roots: [],
          prerequisites: []
        };
        return {
          exposure,
          resources: { work: 1, native_bytes: 0, memory_bytes: 64, sql_internal_work: "unknown" as const }
        };
      }
    } : {})
  };
}

function makeRequest(
  readers: ObserverReaders,
  overrides?: Partial<ConditionalFieldRecallRequest>
): ConditionalFieldRecallRequest {
  return {
    workspace_id: WS,
    query_text: "needle",
    budget: defaultBudget({ page_budget: 10 }),
    snapshot_id: sha("snapshot"),
    interpretation_clock: CLOCK,
    as_of: CLOCK,
    expires_at: FAR_FUTURE_EXPIRY,
    readers,
    authorized_scopes: ["project"],
    enumeration_policy: "native_query",
    result_kind_view: "source_only",
    delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 1_000_000 },
    ...capableRecallConsumerDeclaration(),
    ...overrides
  };
}

function encodeEnvelope(
  req: ConditionalFieldRecallRequest,
  executed: ReturnType<typeof runConditionalFieldRecallWithReceipt>
) {
  const previews = captureIndexPreviews(executed.index, req.readers, WS);
  const metadata = captureIndexSourceMetadata(executed.index);
  const results = encodeIndexResults(executed.index, previews, 2_000, metadata);
  const reframed = frameEncodedIndex(executed.index, results);
  const wire = encodeRecallPageResponse({
    delivery_id: `delivery_${executed.delivery_id ?? "p1"}`,
    index: reframed,
    results,
    active_constraints: [],
    active_constraints_count: null,
    degradation_reason: null
  });
  return { previews, metadata, results, reframed, wire };
}

describe("Page-1 fixed-fragment Delta + Next packing", () => {
  it("widens Page 1 from 3 literal slots to 4 Delta slots under 2,000 B, preserves reframing, and resumes at slot 5", () => {
    // Each message is 340 B; with ~290 B literal SourceDisclosure, each slot is ~630 B.
    // Literally 3 slots = ~1,890 B <= 2,000 B < 4 slots (~2,520 B).
    // With Codec v2 page_delta saving ~260 B per slot after anchor, 4 slots = ~1,740 B <= 2,000 B.
    const roots: MockRoot[] = Array.from({ length: 6 }, (_, idx) => {
      const m1 = `needle r${idx} ${"a".repeat(330)}`;
      const m2 = `tail r${idx} ${"b".repeat(1691)}`;
      return {
        id: `root-${idx}`,
        body: `${m1}${m2}`,
        messages: [Buffer.byteLength(m1), Buffer.byteLength(m1) + Buffer.byteLength(m2)]
      };
    });

    const req = makeRequest(makeReaders(roots));
    const page1 = runConditionalFieldRecallWithReceipt(req);
    expect(page1.index.result_version).toBe(ORDINARY_NATIVE_FIELD_RESULT_VERSION);
    expect(page1.index.representation.disclosure_codec).toBe("page_delta");
    const page1Ids = page1.index.entries.map(e => e.target.kind === "source_evidence" ? e.target.root_id : null);
    expect(page1Ids).toHaveLength(4);

    const { reframed, results, wire } = encodeEnvelope(req, page1);
    expect(reframed.entries).toEqual(page1.index.entries);
    expect(results).toHaveLength(4);
    expect(Array.isArray(wire.results[0]!.source_disclosure)).toBe(true);
    for (const row of wire.results.slice(1)) {
      expect(Array.isArray(row.source_disclosure)).toBe(false);
      expect(row.source_disclosure).toMatchObject({ v: 2 });
    }

    const decoded = SoulMemorySearchResponseSchema.parse(wire);
    for (const row of decoded.results) {
      expect(Array.isArray(row.source_disclosure)).toBe(true);
      expect(sourceDisclosure(row.source_disclosure!)).toMatchObject({
        material_kind: "original_body",
        evaluated_as_of: CLOCK
      });
    }

    // Page 2 resumes cleanly at z_{j+1} with literal disclosure codec and covers the remaining 2 roots.
    expect(page1.index.continuation).not.toBeNull();
    const page2 = runConditionalFieldRecallWithReceipt({ ...req, continuation: page1.index.continuation });
    expect(page2.index.representation.disclosure_codec).toBeUndefined();
    const page2Ids = page2.index.entries.map(e => e.target.kind === "source_evidence" ? e.target.root_id : null);
    expect(page2Ids).toHaveLength(2);
    expect(new Set([...page1Ids, ...page2Ids])).toEqual(new Set(roots.map(r => r.id)));
  });

  it("Counterexample 12: never truncates a deferred multi-message row 2 into a small residual scrap on Page 1", () => {
    // Row 0 consumes ~1,568 B on V_1 (1,400 B + ~168 B disclosure), leaving ~432 B literal (~572 B with delta).
    // Row 1 has M1 = 500 B and M2 = 750 B (1,250 B multi-message prefix) + M3 = 1,500 B.
    // On V_1 literally, 500 + 168 = 668 > 432, so row 1 defers to V_2 where z_2 delivers 1,250 B (M1 + M2).
    // Fixed-fragment Delta sees z_1 (~1,568) + z_2 (~1,418) - savings (~140) = ~2,846 > 2,000, keeping row 1 on Page 2.
    const r0m1 = `needle r0 ${"x".repeat(1390)}`;
    const r1m1 = `needle r1 m1 ${"y".repeat(487)}`;
    const r1m2 = `r1 m2 ${"z".repeat(744)}`;
    const r1m3 = `r1 m3 ${"w".repeat(1494)}`;
    const roots: MockRoot[] = [
      { id: "r0", body: r0m1, messages: [Buffer.byteLength(r0m1)] },
      {
        id: "r1",
        body: `${r1m1}${r1m2}${r1m3}`,
        messages: [
          Buffer.byteLength(r1m1),
          Buffer.byteLength(r1m1) + Buffer.byteLength(r1m2),
          Buffer.byteLength(r1m1) + Buffer.byteLength(r1m2) + Buffer.byteLength(r1m3)
        ]
      }
    ];

    const req = makeRequest(makeReaders(roots));
    const page1 = runConditionalFieldRecallWithReceipt(req);
    expect(page1.index.entries.map(e => e.target.kind === "source_evidence" ? e.target.root_id : null))
      .toEqual(["r0"]);

    expect(page1.index.continuation).not.toBeNull();
    const page2 = runConditionalFieldRecallWithReceipt({ ...req, continuation: page1.index.continuation });
    const page2Enc = encodeEnvelope(req, page2);
    expect(page2Enc.results).toHaveLength(1);
    expect(page2Enc.results[0]!.content_preview).toBe(`${r1m1}${r1m2}`);
    expect(page2Enc.results[0]!.target).toMatchObject({
      root_id: "r1",
      span: { content_start: 0, content_end: 1250, content_complete: false }
    });
  });

  it("Residual Next extends an incomplete Page-1 slot to its next message right boundary when dependencies are contained", () => {
    const m1 = `needle user prompt ${"p".repeat(381)}`; // 400 B
    const m2 = `assistant reply ${"r".repeat(484)}`;    // 500 B -> end 900
    const m3 = `later turn ${"l".repeat(1989)}`;        // 2000 B -> end 2900
    const body = `${m1}${m2}${m3}`;
    const b1 = Buffer.byteLength(m1);
    const b2 = b1 + Buffer.byteLength(m2);
    const b3 = b2 + Buffer.byteLength(m3);

    const root: MockRoot = {
      id: "conv-1",
      body,
      messages: [b1, b2, b3],
      dependency: span => ({
        status: "complete",
        roots: [{
          occurrence_id: "occ-m2",
          utf8_span: [span[0], span[1]],
          dependencies: [{
            source_id: "conv-1",
            root_id: "conv-1",
            source_version: "1",
            content_digest: sha(body),
            occurrence_id: "occ-m1"
          }]
        }],
        prerequisites: [{
          reference: {
            source_id: "conv-1",
            root_id: "conv-1",
            source_version: "1",
            content_digest: sha(body),
            occurrence_id: "occ-m1"
          },
          status: "partial",
          utf8_span: [0, b1],
          content_span: [0, 0],
          dependencies: []
        }]
      })
    };

    const req = makeRequest(makeReaders([root]), {
      budget: defaultBudget({ page_budget: 1 })
    });
    const page1 = runConditionalFieldRecallWithReceipt(req);
    const { reframed, results } = encodeEnvelope(req, page1);
    expect(reframed.entries).toEqual(page1.index.entries);
    expect(results).toHaveLength(1);
    expect(results[0]!.content_preview).toBe(`${m1}${m2}`);
    expect(results[0]!.target).toMatchObject({
      root_id: "conv-1",
      span: { content_start: 0, content_end: b2, content_complete: false, retained_extent: "body" }
    });
  });

  it("Residual Next rejects extensions requiring a missing preceding prompt, unavailable dependency, or overflowing residual", () => {
    const m1 = `prompt ${"p".repeat(393)}`;   // [0, 400)
    const m2 = `reply ${"r".repeat(294)}`;    // [400, 700)
    const m3 = `followup ${"f".repeat(391)}`; // [700, 1100)
    const body = `${m1}${m2}${m3}`;
    const b1 = Buffer.byteLength(m1);
    const b2 = b1 + Buffer.byteLength(m2);
    const b3 = b2 + Buffer.byteLength(m3);

    // Case A: Opened at M2 ([400, 700)); M3 depends on M1 ([0, 400) < content_start=400).
    const missingPromptRoot: MockRoot = {
      id: "missing-prompt",
      body,
      messages: [b1, b2, b3],
      dependency: span => ({
        status: "partial",
        roots: [{
          occurrence_id: "occ-m3",
          utf8_span: [span[0], span[1]],
          dependencies: [{
            source_id: "missing-prompt",
            root_id: "missing-prompt",
            source_version: "1",
            content_digest: sha(body),
            occurrence_id: "occ-m1"
          }]
        }],
        prerequisites: [{
          reference: {
            source_id: "missing-prompt",
            root_id: "missing-prompt",
            source_version: "1",
            content_digest: sha(body),
            occurrence_id: "occ-m1"
          },
          status: "partial",
          utf8_span: [0, b1],
          content_span: [0, 0]
        }]
      })
    };
    const missingPromptReq = makeRequest(makeReaders([missingPromptRoot], {
      payloadRange: () => ({ start_byte: b1, end_byte: b2 })
    }), { budget: defaultBudget({ page_budget: 1 }) });
    const missingPromptPage = runConditionalFieldRecallWithReceipt(missingPromptReq);
    expect(missingPromptPage.index.entries[0]!.target).toMatchObject({
      span: { content_start: b1, content_end: b2, content_complete: false }
    });

    // Case B: M2 ([400, 700)) depends on an unavailable/erased occurrence.
    const unavailableDepRoot: MockRoot = {
      id: "erased-dep",
      body,
      messages: [b1, b2, b3],
      dependency: span => ({
        status: "partial",
        roots: [{
          occurrence_id: "occ-m2",
          utf8_span: [span[0], span[1]],
          dependencies: [{
            source_id: "other-root",
            root_id: "other-root",
            source_version: "1",
            content_digest: sha("other"),
            occurrence_id: "occ-other"
          }]
        }],
        prerequisites: [{
          reference: {
            source_id: "other-root",
            root_id: "other-root",
            source_version: "1",
            content_digest: sha("other"),
            occurrence_id: "occ-other"
          },
          status: "unavailable"
        }]
      })
    };
    const erasedReq = makeRequest(makeReaders([unavailableDepRoot], {
      payloadRange: () => ({ start_byte: 0, end_byte: b1 })
    }), { budget: defaultBudget({ page_budget: 1 }) });
    const erasedPage = runConditionalFieldRecallWithReceipt(erasedReq);
    expect(erasedPage.index.entries[0]!.target).toMatchObject({
      span: { content_start: 0, content_end: b1, content_complete: false }
    });

    // Case C: M2 exceeds residualBytes (400 + 1800 > 2000).
    const largeM2 = `huge ${"h".repeat(1795)}`;
    const largeBody = `${m1}${largeM2}`;
    const overflowRoot: MockRoot = {
      id: "overflow-next",
      body: largeBody,
      messages: [b1, b1 + Buffer.byteLength(largeM2)]
    };
    const overflowReq = makeRequest(makeReaders([overflowRoot]), { budget: defaultBudget({ page_budget: 1 }) });
    const overflowPage = runConditionalFieldRecallWithReceipt(overflowReq);
    expect(overflowPage.index.entries[0]!.target).toMatchObject({
      span: { content_start: 0, content_end: b1, content_complete: false }
    });
  });

  it("falls back cleanly to literal shrink when outer max_encoded_bytes rejects the widened Delta page", () => {
    const roots: MockRoot[] = Array.from({ length: 4 }, (_, idx) => {
      const m1 = `needle r${idx} ${"a".repeat(389)}`;
      const m2 = `tail r${idx} ${"b".repeat(1691)}`;
      return {
        id: `root-${idx}`,
        body: `${m1}${m2}`,
        messages: [Buffer.byteLength(m1), Buffer.byteLength(m1) + Buffer.byteLength(m2)]
      };
    });
    const req = makeRequest(makeReaders(roots), {
      delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 5_500 }
    });
    const page1 = runConditionalFieldRecallWithReceipt(req);
    expect(page1.index.representation.disclosure_codec).toBeUndefined();
    expect(page1.index.entries.length).toBeLessThan(4);
    expect(page1.index.entries.length).toBeGreaterThanOrEqual(1);

    expect(() => runConditionalFieldRecallWithReceipt(makeRequest(makeReaders(roots), {
      delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 64 }
    }))).toThrow("Recall output budget cannot carry its required public envelope");
  });

  it("handles bounded narrower reprojection, rejects unknown dependencies, preserves omitted fragments, respects literal codec, and never restores framing work", () => {
    // 1. Bounded narrower reprojection returning fewer entries than widened.j must not crash.
    const eightRoots: MockRoot[] = Array.from({ length: 8 }, (_, idx) => {
      const m1 = `needle r${idx} ${"a".repeat(330)}`;
      return { id: `b-${idx}`, body: m1, messages: [Buffer.byteLength(m1)] };
    });
    const tightReprojReq = makeRequest(makeReaders(eightRoots), {
      budget: defaultBudget({ page_budget: 10, work_units: 260, finalization_reserve: 10 })
    });
    const tightRes = runConditionalFieldRecallWithReceipt(tightReprojReq);
    expect(tightRes.index.entries.length).toBeLessThanOrEqual(8);

    // 2. Next rejects occurrences with unknown (undefined) prerequisite declarations.
    const m1 = `needle prompt ${"p".repeat(386)}`; // 400 B
    const m2 = `reply ${"r".repeat(494)}`;         // 500 B
    const m3 = `tail ${"t".repeat(1995)}`;         // 2000 B
    const unknownDepBody = `${m1}${m2}${m3}`;
    const unknownDepRoot: MockRoot = {
      id: "unknown-dep",
      body: unknownDepBody,
      messages: [400, 900, 2900],
      dependency: span => ({
        status: "unknown",
        roots: [{ occurrence_id: "occ-m2", utf8_span: [span[0], span[1]] }],
        prerequisites: []
      })
    };
    const unknownDepPage = runConditionalFieldRecallWithReceipt(
      makeRequest(makeReaders([unknownDepRoot], {
        payloadRange: () => ({ start_byte: 0, end_byte: 400 })
      }), { budget: defaultBudget({ page_budget: 1 }) })
    );
    expect(unknownDepPage.index.entries[0]!.target).toMatchObject({
      span: { content_start: 0, content_end: 400, content_complete: false }
    });

    // 3. Omitted middle fragment (payload_available: false) never silently materializes bytes under Delta packing,
    // and encodeRecallPageResponse respects explicit disclosure_codec: "literal".
    const probeEnc = encodeEnvelope(
      makeRequest(makeReaders([{ id: "probe", body: "x", messages: [] }])),
      runConditionalFieldRecallWithReceipt(makeRequest(makeReaders([{ id: "probe", body: "x", messages: [] }])))
    );
    const discBytes = Buffer.byteLength(JSON.stringify({ source_disclosure: probeEnc.results[0]!.source_disclosure }));
    const omittedHead = `needle ${"h".repeat(Math.max(1, 2_000 - 2 * discBytes - 39))}`;
    const omittedMid = "mid twenty byte text";
    const omittedTail = "end twenty byte text";
    const omittedMidRoots: MockRoot[] = [
      { id: "om-0", body: omittedHead, messages: [] },
      { id: "om-1", body: omittedMid, messages: [], omitPayload: true },
      { id: "om-2", body: omittedTail, messages: [] }
    ];
    const omittedReq = makeRequest(makeReaders(omittedMidRoots));
    const omittedExec = runConditionalFieldRecallWithReceipt(omittedReq);
    const omittedWire = encodeEnvelope(omittedReq, omittedExec);
    expect(omittedWire.results.map(row => [row.target.kind === "source_evidence" && row.target.root_id, row.payload_available]))
      .toEqual([["om-0", true], ["om-1", false], ["om-2", true]]);
    expect(omittedWire.results[1]?.content_preview).toBe("[payload omitted]");
    expect(omittedWire.results[1]?.target).toMatchObject({ root_id: "om-1" });

    // 3b. A locked tail one byte over the residual is deferred intact.
    const remaining = omittedWire.results[2]!.budget_state.remaining_tokens;
    expect(remaining).toBeTypeOf("number");
    const tailCapacity = remaining! + Buffer.byteLength(omittedTail);
    const tooLargeTail = "z".repeat(tailCapacity + 1);
    const fittingTail = "y".repeat(tailCapacity);

    const requestWithTail = (body: string) => makeRequest(makeReaders([
      ...omittedMidRoots.slice(0, 2), { id: "om-2", body, messages: [] }
    ]));
    const oversizeReq = requestWithTail(tooLargeTail);
    const oversize = runConditionalFieldRecallWithReceipt(oversizeReq);
    const first = encodeEnvelope(oversizeReq, oversize);
    expect(first.results).toHaveLength(2);
    expect(first.results[0]?.target).toMatchObject({ root_id: "om-0", span: { content_complete: true } });
    expect(first.results[1]?.payload_available).toBe(false);
    const resumed = runConditionalFieldRecallWithReceipt({ ...oversizeReq, continuation: oversize.index.continuation });
    const second = encodeEnvelope(oversizeReq, resumed);
    expect(second.results).toHaveLength(1);
    expect(second.results[0]?.content_preview).toBe(tooLargeTail);
    expect(second.results[0]?.target).toMatchObject({ root_id: "om-2",
      span: { content_end: tailCapacity + 1, content_complete: true } });

    const fittingReq = requestWithTail(fittingTail);
    const fitting = encodeEnvelope(fittingReq, runConditionalFieldRecallWithReceipt(fittingReq));
    expect(fitting.results).toHaveLength(3);
    expect(fitting.results[1]?.payload_available).toBe(false);
    expect(fitting.results[2]?.content_preview).toBe(fittingTail);
    expect(fitting.results[2]?.target).toMatchObject({ root_id: "om-2",
      span: { content_end: tailCapacity, content_complete: true } });
    const literalReq = makeRequest(makeReaders(omittedMidRoots.slice(1)));
    const literalExec = runConditionalFieldRecallWithReceipt(literalReq);
    const literalIndex = {
      ...literalExec.index,
      representation: { ...literalExec.index.representation, disclosure_codec: "literal" as const }
    };
    const literalPreviews = captureIndexPreviews(literalIndex, literalReq.readers, WS);
    const literalMeta = captureIndexSourceMetadata(literalExec.index);
    const literalResults = encodeIndexResults(literalIndex, literalPreviews, 2_000, literalMeta);
    const literalWire = encodeRecallPageResponse({
      delivery_id: "delivery_literal",
      index: literalIndex,
      results: literalResults,
      active_constraints: [],
      active_constraints_count: null,
      degradation_reason: null
    });
    expect(literalWire.results).toHaveLength(2);
    expect(Array.isArray(literalWire.results[0]!.source_disclosure)).toBe(true);
    expect(Array.isArray(literalWire.results[1]!.source_disclosure)).toBe(true);
    expect(SoulMemorySearchResponseWireSchema.safeParse({
      ...omittedWire.wire,
      index: {
        ...omittedWire.wire.index!,
        representation: { ...omittedWire.wire.index!.representation, disclosure_codec: "literal" }
      }
    }).success).toBe(false);
    expect(SoulMemorySearchResponseWireSchema.safeParse({
      ...omittedWire.wire,
      index: {
        ...omittedWire.wire.index!,
        representation: {
          schema_version: omittedWire.wire.index!.representation.schema_version,
          policy: omittedWire.wire.index!.representation.policy,
          page_budget: omittedWire.wire.index!.representation.page_budget,
          identity_tie_break: omittedWire.wire.index!.representation.identity_tie_break
        }
      }
    }).success).toBe(false);

    // 4. Next refuses to extend when dependency reader or authorized scopes are absent.
    const noDepReaderRoot: MockRoot = { id: "no-dep-reader", body: unknownDepBody, messages: [400, 900, 2900] };
    const noDepReaderPage = runConditionalFieldRecallWithReceipt(
      makeRequest(makeReaders([noDepReaderRoot], { payloadRange: () => ({ start_byte: 0, end_byte: 400 }) }), {
        budget: defaultBudget({ page_budget: 1 })
      })
    );
    expect(noDepReaderPage.index.entries[0]!.target).toMatchObject({
      span: { content_start: 0, content_end: 400, content_complete: false }
    });
    const noScopeReaders = makeReaders([{
      ...noDepReaderRoot,
      dependency: span => ({
        status: "complete",
        roots: [{ occurrence_id: "occ-m2", utf8_span: [span[0], span[1]], dependencies: [] }],
        prerequisites: []
      })
    }], { payloadRange: () => ({ start_byte: 0, end_byte: 400 }) });
    const noScopePayload = new BoundedIndexPayload({
      readers: noScopeReaders,
      workspaceId: WS,
      authorizedScopes: undefined,
      asOf: CLOCK,
      remainingMemoryBytes: 1_000_000,
      manifestationFor: () => "excerpt"
    });
    noScopePayload.finalize(noDepReaderPage.index.entries, 100);
    expect(noScopePayload.extendNextMessageBoundary({
      entry: noDepReaderPage.index.entries[0]!,
      residualBytes: 800,
      availableWork: 100,
      framingReserve: 10,
      retentionBytes: 0
    })).toEqual({ extendedBytes: 0, spentWork: 0 });

    // 5. Framing work spent during Next is never restored into the outer fit allowance.
    let heavyNextCalls = 0;
    const heavyRoot: MockRoot = {
      id: "heavy-next",
      body: unknownDepBody,
      messages: [400, 900, 2900],
      dependency: span => ({
        status: "complete",
        roots: [{ occurrence_id: "occ-m2", utf8_span: [span[0], span[1]], dependencies: [] }],
        prerequisites: []
      })
    };
    const heavyReaders: ObserverReaders = {
      ...makeReaders([heavyRoot]),
      sourceRoot: input => {
        const base = makeReaders([heavyRoot]).sourceRoot!(input);
        if ((input.offset ?? 0) > 0) {
          heavyNextCalls += 1;
          return { ...base, nativeWork: 8 };
        }
        return base;
      }
    };
    let observedFitAllowance: number | undefined;
    runConditionalFieldRecallWithReceipt(makeRequest(heavyReaders, {
      budget: defaultBudget({ page_budget: 10, work_units: 70, finalization_reserve: 5 }),
      observe_page_attempt: capture => {
        observedFitAllowance ??= capture().allowance.work_units;
      }
    }));
    if (heavyNextCalls > 0 && observedFitAllowance !== undefined) {
      expect(observedFitAllowance).toBeLessThan(70);
    }
  });
});
