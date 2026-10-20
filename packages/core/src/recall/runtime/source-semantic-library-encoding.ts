import {
  SourceSemanticLibraryDeliverySchema, SourceSemanticWorkerResultSchema,
  MemorySearchResultSchema, IndexEntrySchema, sourceSemanticExecution,
  indexEntryCacheKey, verifySourceSemanticLibraryDelivery,
  type SourceSemanticResourceBudget, type InformationIndex, type IndexEntry, type MemorySearchResult, type SourceDisclosure,
  type SourceSemanticAccessReceipt, type SourceSemanticExecution, type SourceSemanticCoverage,
  type SoulInterpretationResponse
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { preparedDeliveryId } from "./index-continuation.js";
import { captureInput, quoteCapture, encodeOwned, encodeSourceSemanticLibraryResults,
  payloadBudget, PAYLOAD_TOKENS, rawLibraryEntry as rawEntry, type Recall, type Meter, type CapturePrices } from "./source-semantic-library-codec.js";
// Stable codec consumers keep this entry; component/session machinery stays private to Core.
export { encodeSourceSemanticLibraryResults, encodeSourceSemanticLibraryResponse, sourceSemanticLibraryRawPreview }
  from "./source-semantic-library-codec.js";

type MaterializedEncoding = Readonly<{ response: SoulInterpretationResponse; capture: SourceSemanticResourceBudget }>;
type EncodingQuote = Readonly<{ bytes: number; withinBudget: boolean; payloadGrowth: number;
  capture: SourceSemanticResourceBudget }>;
type RawMemberInput = Readonly<{ entry: IndexEntry; preview: string; source_disclosure: SourceDisclosure;
  source_access?: SourceSemanticAccessReceipt["source_candidates"][number] }>;
type RawMember = Readonly<{ kind: "raw_library_member" }>;
type RawFrame = Readonly<{ index: Pick<InformationIndex, "completeness" | "continuation" | "order_status">;
  access: Readonly<{ source_order: readonly number[]; trace: SourceSemanticAccessReceipt["trace"] }> | undefined;
  slot_qualifiers: Recall["slot_qualifiers"]; payload: SourceSemanticCoverage["payload"]; execution: "initial" | "continuation" }>;
type RawEncoding = Readonly<{ initial: EncodingQuote; members: readonly RawMember[];
  member: (input: RawMemberInput) => RawMember | null;
  quote: (frame: RawFrame, members: readonly RawMember[]) => EncodingQuote }>;
export type SourceSemanticLibraryEncoding = Readonly<{
  /** Raw-only immutable evidence. Null requires the complete compatibility path. */
  prepareRaw: (result: Recall, continuationExecution?: SourceSemanticExecution) => RawEncoding | null;
  /** Capture is executed and debited here, not covered by the consumer's later output retention. */
  materialize: (result: Recall) => MaterializedEncoding;
  close: () => void;
}>;

type JsonLength = (value: unknown, overrides?: ReadonlyMap<object, number>) => number;
const RawIndexFrameSchema = SourceSemanticLibraryDeliverySchema.shape.index.unwrap().pick({ completeness: true, continuation: true, order_status: true });
const AccessSchema = SourceSemanticLibraryDeliverySchema.shape.discovery.unwrap().shape.access;
const SourceAccessRowSchema = AccessSchema.unwrap().unwrap().shape.source_candidates.unwrap().element;
const BudgetSchema = MemorySearchResultSchema.unwrap().shape.budget_state;
// All worker operations share these exact field schemas. No second wire schema is authored here.
const WorkerFields = SourceSemanticWorkerResultSchema.options[0].unwrap().shape;
const PayloadSchema = WorkerFields.coverage.unwrap().shape.payload;
type RawEvidence = { entry: IndexEntry; preview: string; disclosure: SourceDisclosure; row: MemorySearchResult;
  key: string; bytes: number; budgetBytes: number; sourceAccess?: SourceSemanticAccessReceipt["source_candidates"][number] };
function rawResult(result: Recall): boolean {
  return (result.proofs?.length ?? 0) === 0 && (result.unproved_computations?.length ?? 0) === 0
    && (result.index.explanations?.length ?? 0) === 0
    && (result.discovery.access?.interpretation_candidates.length ?? 0) === 0
    && result.index.entries.every(entry => rawEntry(entry) && result.previews?.[indexEntryCacheKey(entry)] !== undefined
      && (result.discovery.access === undefined || result.discovery.access.source_candidates.some(row =>
        entry.target.kind === "source_evidence" && row.record_id === entry.target.root_id)));
}
/** Reusable raw evidence and candidate-specific frames; never a retained candidate-envelope cache. */
class RawLibraryComponents implements RawEncoding {
  readonly initial: EncodingQuote;
  readonly members: readonly RawMember[];
  private base: Recall | undefined;
  private readonly evidence = new Map<RawMember, RawEvidence>();
  private readonly meter: Meter;
  private readonly prices: CapturePrices;
  private readonly length: JsonLength;
  private readonly remember: (value: object) => number;
  private shared: object | undefined;
  private readonly sharedBytes: number;
  private readonly discoveryBytes: number;
  private continuationExecution: SourceSemanticExecution | undefined;
  private accessParser: ((value: unknown) => SourceSemanticAccessReceipt) | undefined;
  private readonly fixedIndexPrice: SourceSemanticResourceBudget;
  private activeSources: SourceSemanticAccessReceipt["source_candidates"] | undefined;
  constructor(base: Recall, response: SoulInterpretationResponse, continuation: SourceSemanticExecution,
    initial: EncodingQuote, meter: Meter, prices: CapturePrices, length: JsonLength, remember: (value: object) => number) {
    if (response.operation !== "recall") throw new CoreError("OBLIGATION_VIOLATION", "raw recall projection changed operation");
    this.base = base; this.meter = meter; this.prices = prices; this.length = length; this.remember = remember;
    meter.charge(3, 192 + base.index.entries.length * 8, "library encoding raw prepared evidence");
    this.continuationExecution = captureInput(WorkerFields.execution.parse(captureInput(continuation, meter)), meter, prices)!;
    if (base.discovery.access !== undefined) {
      const schema = AccessSchema.unwrap().unwrap();
      meter.charge(2, 128, "library encoding owned access validator");
      // Only this private owner entry injects the already validated immutable phase
      // component. The private frame has a different input shape, but exactly
      // the original receipt field schemas and checks. No receipt rule is copied.
      // Public wire parsing and missing-phase behavior stay unchanged.
      const owned = schema.omit({ phases: true, source_candidates: true, interpretation_candidates: true }).extend({
        phases: schema.shape.phases.default(base.discovery.access.phases),
        source_candidates: schema.shape.source_candidates.default(() => {
          if (this.activeSources === undefined) throw new CoreError("OBLIGATION_VIOLATION", "raw access projection is unbound");
          return this.activeSources;
        }), interpretation_candidates: schema.shape.interpretation_candidates.default(base.discovery.access.interpretation_candidates)
      });
      // Zod stores these original checks with an erased `never` input. Restore
      // that type only: this private schema produces the same complete receipt.
      const checks = [...(schema.def.checks ?? []), ...(AccessSchema.unwrap().def.checks ?? [])] as Parameters<typeof owned.check>;
      const checked = owned.check(...checks).readonly();
      this.accessParser = value => checked.parse(value);
    }
    const { index: _index, results: _results, coverage: _coverage, source_disclosures: _disclosures,
      delivery_id: _delivery, total_count: _count, discovery: _discovery, slot_qualifiers: _slots, execution: _execution, ...shared } = response;
    // The retained common response fields are schema-readonly scalar records;
    // mutable disclosure/index trees are excluded from this shared frame.
    this.shared = Object.freeze(shared); this.sharedBytes = remember(this.shared);
    const { access: _access, ...discovery } = base.discovery;
    this.discoveryBytes = remember(Object.freeze(discovery));
    this.members = Object.freeze(base.index.entries.map((entry, position) => this.store({ entry,
      preview: base.previews![indexEntryCacheKey(entry)]!, source_disclosure: base.source_disclosures[indexEntryCacheKey(entry)]!,
      source_access: base.discovery.access?.source_candidates.find(row => entry.target.kind === "source_evidence" && row.record_id === entry.target.root_id) },
    _results![position]!)));
    const dynamic = { index: _index, results: _results, coverage: _coverage, source_disclosures: _disclosures,
      delivery_id: _delivery, total_count: _count, discovery: _discovery, slot_qualifiers: _slots, execution: _execution };
    meter.charge(1, 64 + this.members.length * 16, "library encoding initial member sizes");
    const sizes = new Map<object, number>(_results!.map((row, position) => [row, this.evidence.get(this.members[position]!)!.bytes]));
    this.initial = Object.freeze({ ...initial, bytes: this.sharedBytes + length(dynamic, sizes) - 1 });
    const indexPrice = quoteCapture(base.index, meter, prices);
    const replaced = [base.index.entries, base.index.completeness, base.index.continuation].map(value => quoteCapture(value, meter, prices));
    this.fixedIndexPrice = { work_units: indexPrice.work_units - replaced.reduce((sum, cost) => sum + cost.work_units, 0),
      memory_bytes: indexPrice.memory_bytes - replaced.reduce((sum, cost) => sum + cost.memory_bytes, 0) };
  }
  close(): void {
    this.evidence.clear(); this.base = undefined; this.shared = undefined;
    this.continuationExecution = undefined; this.accessParser = undefined; this.activeSources = undefined;
  }
  member(input: RawMemberInput): RawMember | null {
    if (this.base === undefined) throw new CoreError("OBLIGATION_VIOLATION", "library encoding session is closed");
    const owned = captureInput(input, this.meter, this.prices);
    // Incremental eligibility uses the captured snapshot. Missing or non-string
    // previews must not enter this supported path; present empty text remains valid.
    if (!rawEntry(owned.entry) || typeof owned.preview !== "string") return null;
    const price = this.prices.costs.get(owned.entry)!;
    // This strict validation-only entry schema preserves the captured wire fields.
    // Keep its owned result, not another descriptor-copy of that result. The schema
    // allocation remains priced; its CPU cost is not a descriptor traversal count.
    this.meter.charge(2, price.memory_bytes + 48, "library encoding raw entry schema allocation");
    const entry = IndexEntrySchema.parse(owned.entry);
    this.prices.costs.set(entry, price);
    const disclosure = owned.source_disclosure;
    const sourceAccess = owned.source_access === undefined ? undefined : SourceAccessRowSchema.parse(owned.source_access);
    if (sourceAccess !== undefined && (entry.target.kind !== "source_evidence" || sourceAccess.record_id !== entry.target.root_id)) {
      throw new CoreError("VALIDATION", "raw access evidence belongs to another source");
    }
    if (sourceAccess !== undefined) this.prices.costs.set(sourceAccess, this.prices.costs.get(owned.source_access!)!);
    const key = indexEntryCacheKey(entry);
    this.meter.charge(2, 128 + key.length * 2, "library encoding raw member evidence");
    const row = encodeSourceSemanticLibraryResults({ ...this.base.index, entries: [entry] }, new Map([[key, owned.preview]]),
      PAYLOAD_TOKENS, true, { [key]: disclosure })[0]!;
    const projected = MemorySearchResultSchema.parse(row);
    this.meter.retain(projected, "library encoding raw member projection");
    return this.store({ entry, preview: owned.preview, source_disclosure: disclosure, source_access: sourceAccess }, projected);
  }
  private store(input: RawMemberInput, row: MemorySearchResult): RawMember {
    const member: RawMember = Object.freeze({ kind: "raw_library_member" });
    this.meter.charge(1, 96, "library encoding raw member evidence storage");
    // The raw projector's other containers are schema-readonly. Replace its two
    // metadata copies with the already deep-frozen captured components, rather
    // than walking/freezing the complete projected row a second time.
    const projected = Object.freeze({ ...row, target: input.entry.target, source_disclosure: input.source_disclosure });
    const budgetBytes = this.remember(projected.budget_state);
    this.evidence.set(member, { entry: input.entry, preview: input.preview, disclosure: input.source_disclosure, row: projected,
      key: indexEntryCacheKey(input.entry), bytes: this.remember(projected), budgetBytes, sourceAccess: input.source_access });
    this.remember(input.entry); this.remember(input.source_disclosure);
    return member;
  }
  quote(frame: RawFrame, members: readonly RawMember[]): EncodingQuote {
    if (this.base === undefined) throw new CoreError("OBLIGATION_VIOLATION", "library encoding session is closed");
    const base = this.base, meter = this.meter;
    meter.charge(members.length, 64 + members.length * 16, "library encoding raw member lookup");
    const selected = members.map(member => {
      const evidence = this.evidence.get(member);
      if (evidence === undefined) throw new CoreError("VALIDATION", "raw member belongs to another encoding session");
      return evidence;
    });
    if (members.length > base.index.representation.page_budget) throw new CoreError("VALIDATION", "raw page exceeds representation width");
    const input = captureInput(frame, meter, this.prices);
    if (input.execution !== "initial" && input.execution !== "continuation") throw new CoreError("VALIDATION", "unknown raw execution variant");
    const delta = RawIndexFrameSchema.parse(input.index);
    // These are strict validation-only field schemas; their owned copies have the
    // same capture price as the descriptor-captured inputs, without another walk.
    for (const value of ["completeness", "continuation"] as const) {
      const source = input.index[value], target = delta[value];
      if (source !== null && typeof source === "object" && target !== null && typeof target === "object") {
        this.prices.costs.set(target, this.prices.costs.get(source)!);
        meter.charge(1, 16, "library encoding index capture price binding");
      }
    }
    const { entries: _entries, ...fixedIndex } = base.index;
    const header = { ...fixedIndex, ...delta };
    let access = base.discovery.access;
    if (access !== undefined && input.access === undefined) throw new CoreError("VALIDATION", "raw page requires an explicit access frame");
    if (input.access !== undefined) {
      if (access === undefined) throw new CoreError("VALIDATION", "raw access frame has no captured pool");
      const positions = input.access.source_order;
      if (!Array.isArray(positions) || new Set(positions).size !== positions.length) throw new CoreError("VALIDATION", "invalid raw source access positions");
      const sources = Object.freeze(positions.map(position => {
        const row = Number.isSafeInteger(position) && position >= 0 ? selected[position]?.sourceAccess : undefined;
        if (row === undefined) throw new CoreError("VALIDATION", "raw source access has no captured member evidence");
        return row;
      }));
      const values = { ...access, trace: input.access.trace, phases: undefined, source_candidates: undefined, interpretation_candidates: undefined };
      const copy = quoteCapture(values, meter, this.prices);
      meter.charge(copy.work_units, copy.memory_bytes, "library encoding access schema copies");
      const previous = this.activeSources;
      this.activeSources = sources;
      try { access = this.accessParser!(values); } finally { this.activeSources = previous; }
      const borrowed = [base.discovery.access!.phases, sources, base.discovery.access!.interpretation_candidates]
        .map(value => quoteCapture(value, meter, this.prices));
      meter.charge(1, 48, "library encoding access capture price storage");
      this.prices.costs.set(access, Object.freeze({ work_units: copy.work_units + borrowed.reduce((sum, cost) => sum + cost.work_units - 1, 0),
        memory_bytes: copy.memory_bytes + borrowed.reduce((sum, cost) => sum + cost.memory_bytes, 0) }));
    }
    const slots = SourceSemanticLibraryDeliverySchema.shape.slot_qualifiers.parse(input.slot_qualifiers);
    const payload = PayloadSchema.parse(input.payload);
    const execution = input.execution === "initial" ? base.execution! : this.continuationExecution!;
    const total = selected.reduce((sum, row) => sum + row.row.budget_state.token_estimate, 0);
    let used = 0;
    const sizes = new Map<object, number>();
    meter.charge(4 + selected.length, 256 + selected.length * 96, "library encoding raw page composition");
    const results = selected.map((row, position) => {
      const tokens = row.row.budget_state.token_estimate; used += tokens;
      // Captured member tokens are intrinsic; the initial candidate's within_budget is not.
      // payloadBudget admits this combination from those payloads.
      const budget = BudgetSchema.parse(payloadBudget(tokens, used, total, header.representation.page_budget,
        position, PAYLOAD_TOKENS, true, true, PAYLOAD_TOKENS));
      const result = { ...row.row, budget_state: budget };
      sizes.set(result, row.bytes - row.budgetBytes + this.length(budget)); return result;
    });
    const omitted = results.some(row => !row.budget_state.within_budget), incomplete = omitted || payload !== "complete";
    const index: InformationIndex = { ...header, entries: selected.map(row => row.entry),
      completeness: incomplete ? { ...header.completeness, payload: "partial" } : header.completeness };
    const source_disclosures = Object.fromEntries(selected.map(row => [row.key, row.disclosure]));
    const indexCopy = { ...header, entries: index.entries };
    const indexParts = [indexCopy.entries, delta.completeness, delta.continuation].map(value => quoteCapture(value, meter, this.prices));
    meter.charge(1, 48, "library encoding index capture price storage");
    this.prices.costs.set(indexCopy, Object.freeze({
      work_units: this.fixedIndexPrice.work_units + indexParts.reduce((sum, cost) => sum + cost.work_units, 0),
      memory_bytes: this.fixedIndexPrice.memory_bytes + indexParts.reduce((sum, cost) => sum + cost.memory_bytes, 0) }));
    const inputCoverage = { ...base.coverage, payload }, coverage = { ...inputCoverage, payload: omitted ? "truncated" as const : payload };
    const discovery = access === undefined && !Object.hasOwn(base.discovery, "access") ? base.discovery : { ...base.discovery, access };
    const delivery_id = preparedDeliveryId(base.request_identity, index);
    const dynamic = { index, results, coverage, source_disclosures, delivery_id, total_count: selected.length,
      discovery, slot_qualifiers: slots, execution };
    // Reuse the exact cross-field admission authority, on validated owned components.
    verifySourceSemanticLibraryDelivery({ ...base, ...dynamic }, fieldContractSha256);
    sizes.set(discovery, this.discoveryBytes + this.length({ access }) - (access === undefined ? 2 : 1));
    const bytes = this.sharedBytes + this.length(dynamic, sizes) - 1;
    const future = quoteCapture({ ...base, index: indexCopy, previews: Object.fromEntries(selected.map(row => [row.key, row.preview])),
      source_disclosures, delivery_id, total_count: selected.length, discovery, slot_qualifiers: slots,
      coverage: inputCoverage, execution }, meter, this.prices);
    meter.charge(2, 112, "library encoding completion quote");
    return Object.freeze({ bytes, withinBudget: !omitted,
      payloadGrowth: Math.max(0, this.length("truncated") - this.length(payload)),
      capture: Object.freeze({ work_units: future.work_units + 2, memory_bytes: future.memory_bytes + 128 }) });
  }
}

function materializeEncoding(result: Recall, meter: Meter, prices?: CapturePrices,
  captured?: (owned: Recall, response: SoulInterpretationResponse) => void): MaterializedEncoding {
  meter.charge(2, 128, "library encoding materialization record");
  const capture = { work_units: 2, memory_bytes: 128 };
  const owned = captureInput(result, { retain: meter.retain.bind(meter), charge: (work, bytes, reason) => {
    meter.charge(work, bytes, reason);
    if (reason === "library encoding input check" || reason === "library encoding input capture") {
      capture.work_units += work; capture.memory_bytes += bytes;
    }
  } }, prices);
  const response = encodeOwned(owned); captured?.(owned, response);
  return { response, capture: Object.freeze(capture) };
}

function jsonStringCharLength(text: string): number {
  let length = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) length += 2;
    else if (code < 0x20) {
      if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) length += 2;
      else length += 6;
    } else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { length += 2; i++; continue; }
      length += 6;
    } else if (code >= 0xD800 && code <= 0xDFFF) length += 6;
    else length += 1;
  }
  return length;
}
function jsonStringUtf8Bytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20) {
      if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
      else bytes += 6;
    } else if (code < 0x80) bytes += 1;
    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { bytes += 4; i++; continue; }
      bytes += 6;
    } else if (code >= 0xD800 && code <= 0xDFFF) bytes += 6;
    else if (code < 0x800) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}
function jsonScalarUtf8Bytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 4;
    if (value === 0) return 1;
    return Buffer.byteLength(String(value));
  }
  if (typeof value === "string") return jsonStringUtf8Bytes(value);
  throw new CoreError("VALIDATION", "unencodable raw frame");
}

/** Synchronous encoding lifetime only. No whole-envelope cache and no ordinal identity. */
export function createSourceSemanticLibraryEncoding(meter: Meter): SourceSemanticLibraryEncoding {
  let closed = false;
  let reusable: Map<object, number> | undefined, rawSessions: Set<RawLibraryComponents> | undefined;
  const materialize = (result: Recall, prices?: CapturePrices,
    captured?: (owned: Recall, response: SoulInterpretationResponse) => void): MaterializedEncoding => {
    if (closed) throw new CoreError("OBLIGATION_VIOLATION", "library encoding session is closed");
    return materializeEncoding(result, meter, prices, captured);
  };
  const measureReplaced = (value: unknown, overrides?: ReadonlyMap<object, number>): number => {
    const sizeOf = (row: unknown): number => {
      if (row !== null && typeof row === "object") {
        meter.charge(1, 0, "library encoding component size lookup");
        const size = overrides?.get(row) ?? reusable?.get(row);
        if (size !== undefined) return 4;
        if (Array.isArray(row)) {
          let bytes = 2, count = 0;
          for (const item of row) bytes += (count++ === 0 ? 0 : 1) + (item === undefined ? 4 : sizeOf(item));
          return bytes;
        }
        let bytes = 2, count = 0;
        for (const key in row) {
          if (!Object.hasOwn(row, key)) continue;
          const item = (row as Record<string, unknown>)[key];
          if (item === undefined) continue;
          bytes += (count++ === 0 ? 0 : 1) + jsonStringUtf8Bytes(key) + 1 + sizeOf(item);
        }
        return bytes;
      }
      return jsonScalarUtf8Bytes(row);
    };
    return sizeOf(value);
  };
  const escapedComponentBytes = (value: string): number => {
    meter.charge(2, jsonStringCharLength(value) * 2 + 48, "library encoding escaped component");
    return Buffer.byteLength(JSON.stringify(value));
  };
  const frameLength: JsonLength = (value, overrides) => {
    const measured = measureReplaced(value, overrides);
    meter.charge(1, measured * 2 + 48, "library encoding frame bytes");
    let additional = 0;
    const json = JSON.stringify(value, (_key, row: unknown) => {
      if (row !== null && typeof row === "object") {
        const size = overrides?.get(row) ?? reusable?.get(row);
        if (size !== undefined) { additional += size - 4; return null; }
      }
      return row;
    });
    if (json === undefined) throw new CoreError("VALIDATION", "unencodable raw frame");
    const bytes = Buffer.byteLength(json);
    if (bytes !== measured) throw new CoreError("OBLIGATION_VIOLATION", "raw frame size diverged");
    return bytes + additional;
  };
  const remember = (value: object): number => {
    const prior = reusable?.get(value);
    if (prior !== undefined) return prior;
    const size = frameLength(value);
    if (reusable === undefined) {
      meter.charge(1, 64, "library encoding reusable size table"); reusable = new Map();
    }
    meter.charge(1, 48, "library encoding reusable component size"); reusable.set(value, size);
    return size;
  };
  return {
    materialize: result => materialize(result),
    prepareRaw: (result, continuationExecution = sourceSemanticExecution()) => {
      if (closed) throw new CoreError("OBLIGATION_VIOLATION", "library encoding session is closed");
      meter.charge(3, 192, "library encoding raw component tables");
      const prices: CapturePrices = { costs: new WeakMap(), work: 0, bytes: 0 };
      let input: Recall | undefined;
      const { response, capture } = materialize(result, prices, owned => { input = owned; });
      if (!rawResult(input!)) return null;
      const initial = { bytes: 0, capture,
        withinBudget: "results" in response && response.results !== undefined && response.results.every(row => row.budget_state.within_budget),
        payloadGrowth: Math.max(0, escapedComponentBytes("truncated") - escapedComponentBytes(input!.coverage.payload)) };
      meter.retain(response, "candidate delivery encoding");
      const raw = new RawLibraryComponents(input!, response, continuationExecution, initial, meter, prices, frameLength, remember);
      if (rawSessions === undefined) {
        meter.charge(1, 64, "library encoding raw lifetime table"); rawSessions = new Set();
      }
      rawSessions.add(raw); return raw;
    },
    close: () => {
      reusable?.clear();
      if (rawSessions !== undefined) for (const raw of rawSessions) raw.close();
      rawSessions?.clear(); closed = true;
    }
  };
}
