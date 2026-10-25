import { describe, expect, it } from "vitest";
import { canonicalJson, isHostOccurrenceResourceLimit, type HostOccurrence, type SourceAdmissionContext, type SourceAdmissionRequest } from "@do-soul/alaya-protocol";
import { createInMemoryFieldStores } from "../../memory/evidence-create/field-stores.js";
import { createSourceAdmissionPort } from "../../memory/evidence-create/source-admission.js";
import { emitDeterministicIncidences } from "../../memory/evidence-create/factor-emit.js";
import { fieldContractSha256 as sha256 } from "../../shared/field-hash.js";

const occurrence = (overrides: Partial<HostOccurrence> = {}): HostOccurrence => ({ occurrence_id: "local-0",
  utf8_span: [0, 5], role: "tool", channel: null, author_ref: null, container_ref: null,
  upstream_message_ref: null, upstream_position: null, completeness: "complete", fidelity: "original_bytes", ...overrides });
const request = (overrides: Partial<SourceAdmissionRequest> = {}): SourceAdmissionRequest => ({
  workspace_id: "workspace-1", source_id: "record", source_version: "1", content_bytes: "café",
  recorded_at: "2026-09-13T00:00:00Z", event_time: null, valid_from: null, valid_to: null, evidence_object_id: null,
  spans: [{ start_offset: 0, end_offset: 5, purpose: "native_structure" }], ...overrides });
const context: SourceAdmissionContext = { workspaceId: "workspace-1", hostCapture: request => ({
  namespace: "authored-fixture", workspace_id: request.workspace_id, producer: "structured-fixture", basis: "pinned_dataset" }) };
function fixture() {
  const stores = createInMemoryFieldStores();
  return { stores, port: createSourceAdmissionPort({ stores, sha256 }) };
}

describe("host occurrence source admission", () => {
  it("keeps unknown, captured empty and empty messages distinct without changing source identity or factor bytes", () => {
    const plain = fixture(), captured = fixture();
    const before = plain.port.admit(request());
    const after = captured.port.admit(request({ host_occurrences: [occurrence(), occurrence({
      occurrence_id: "empty", utf8_span: [5, 5] })] }), context);
    expect(before.record.identity).toBe(after.record.identity);
    expect(after.record.attribution_context).toEqual(before.record.attribution_context);
    expect(after.record.speaker).toBe(before.record.speaker);
    expect(after.spans.map(row => row.purpose)).toEqual(["native_structure", "message"]);
    expect(after.record.host_structure?.occurrence_count).toBe(2);
    const factors = (spans: typeof after.spans) => emitDeterministicIncidences({ sha256,
      workspace_id: "workspace-1", scope: "workspace-1", source_id: "record", source_version: "1", content_bytes: "café",
      recorded_at: "2026-09-13T00:00:00Z", actor: "user_action", event_time: null, valid_from: null, valid_to: null,
      factFrameSlots: [], semanticSurfaces: [], spans });
    expect(canonicalJson(factors([after.spans[1]!, after.spans[0]!]))).toBe(canonicalJson(factors(before.spans)));
    expect(plain.stores.getHostInventory("workspace-1", before.record.identity)).toBeNull();
    const empty = captured.port.admit(request({ source_id: "empty-inventory", host_occurrences: [] }), context);
    expect(empty.record.host_structure?.occurrence_count).toBe(0);
    expect(empty.spans).toHaveLength(1);
    const excerpt = captured.port.admit(request({ source_id: "excerpt", host_occurrences: [occurrence({ completeness: "excerpt" })] }), context);
    expect(excerpt.spans).toHaveLength(1);
  });

  it("copies before issuer callbacks, requires real context and retains only exact stored inventories", () => {
    const f = fixture();
    const input = request({ host_occurrences: [occurrence()] });
    expect(() => f.port.admit(input)).toThrow(/context/);
    expect(() => f.port.admit(input, { workspaceId: "elsewhere", hostCapture: context.hostCapture })).toThrow(/context/);
    expect(() => f.port.admit(input, { workspaceId: "workspace-1" })).toThrow(/trusted/);
    expect(() => f.port.admit(input, { ...context, hostCapture: () => ({
      ...context.hostCapture!(input), workspace_id: "elsewhere" }) })).toThrow(/workspace/);
    expect(() => f.port.admit(input, { ...context, hostCapture: () => ({
      ...context.hostCapture!(input), basis: "reported_excerpt" }) })).toThrow(/completeness/);
    const admitted = f.port.admit(input, { ...context, hostCapture: candidate => {
      Object.assign(candidate, { content_bytes: "changed" });
      return context.hostCapture!(input);
    } });
    expect(f.stores.getStoredRecord("workspace-1", admitted.record.identity)?.content_bytes).toBe("café");
    const retained = request({ host_structure: admitted.record.host_structure });
    expect(f.port.admit(retained)).toEqual(admitted);
    expect(() => fixture().port.admit(retained)).toThrow(/exact retained/);
    expect(() => f.port.admit(request())).toThrow(/omitted/);
    expect(() => f.port.admit(request({ host_occurrences: [occurrence({ role: "system" })] }), context)).toThrow(/replay/);
    expect(() => f.port.admit(request({ spans: [{ start_offset: 0, end_offset: 5, purpose: "message" }] }))).toThrow(/derived/);
  });

  it("keeps explicit oversized capture mandatory and distinguishes resource refusal from malformed facts", () => {
    const f = fixture();
    const host_occurrences = Array.from({ length: 23 }, (_, index) => occurrence({
      occurrence_id: `message-${index}`, utf8_span: [0, 0], role: "雪".repeat(1024) }));
    let refusal: unknown;
    try { f.port.admit(request({ host_occurrences }), context); } catch (error) { refusal = error; }
    expect(isHostOccurrenceResourceLimit(refusal)).toBe(true);
    expect(f.stores.listRecords("workspace-1")).toEqual([]);
    expect(f.stores.listSpans("workspace-1")).toEqual([]);
    host_occurrences[1] = host_occurrences[0]!;
    try { f.port.admit(request({ host_occurrences }), context); } catch (error) { refusal = error; }
    expect(isHostOccurrenceResourceLimit(refusal)).toBe(false);
    expect(f.stores.listRecords("workspace-1")).toEqual([]);
    expect(() => f.port.findRetained!(request(), { workspaceId: "elsewhere" })).toThrow(/workspace/);
  });

  it("rejects invalid UTF-8, overlapping, oversized and expanded JSON inventories atomically", () => {
    const f = fixture();
    const bad: readonly HostOccurrence[][] = [
      [occurrence({ utf8_span: [0, 4] })],
      [occurrence(), occurrence({ occurrence_id: "overlap", utf8_span: [0, 1] })],
      Array.from({ length: 257 }, (_, index) => occurrence({ occurrence_id: `empty-${index}`, utf8_span: [0, 0] })),
      [occurrence({ role: "雪".repeat(1366) })],
      [occurrence({ role: "\u0000".repeat(1024), channel: "\u0000".repeat(1024),
        author_ref: { scope: "\u0000".repeat(256), id: "\u0000".repeat(256) },
        container_ref: { scope: "\u0000".repeat(256), id: "\u0000".repeat(256) } })],
      Array.from({ length: 60 }, (_, index) => occurrence({ occurrence_id: `empty-${index}`, utf8_span: [0, 0], role: "r".repeat(1024) }))
    ];
    for (const host_occurrences of bad) {
      expect(() => f.port.admit(request({ host_occurrences }), context)).toThrow();
      expect(f.stores.listRecords("workspace-1")).toEqual([]);
      expect(f.stores.listSpans("workspace-1")).toEqual([]);
    }
    expect(() => f.port.admit(request({ host_occurrences: [occurrence()], spans: [
      { start_offset: 0, end_offset: 1, purpose: "line" }, { start_offset: 0, end_offset: 4, purpose: "line" }
    ] }), context)).toThrow();
    expect(f.stores.listRecords("workspace-1")).toEqual([]);
  });
});
