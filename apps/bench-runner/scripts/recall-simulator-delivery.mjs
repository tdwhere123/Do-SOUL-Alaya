// Re-encode captured candidates with the same production page codec as ordinary recall.
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { indexEntryCacheKey } from "@do-soul/alaya-protocol";
import { authorizeSourceIndexScope } from "@do-soul/alaya-core";
import { encodeIndexResults } from "../../../packages/core/dist/recall/runtime/recall-page-encoding.js";
import { sourceDeliveryPrefix } from "../../../packages/core/dist/recall/runtime/source-delivery-prefix.js";
import { withRecallSnapshot } from "./recall-bound-snapshot.mjs";

const Database = createRequire(new URL("../package.json", import.meta.url))("better-sqlite3");
const rootId = target => target?.kind === "source_evidence" ? target.root_id : null;

/** This order is the observed field order, not a reconstruction from delivered answers. */
export function observedAccessOrder(capture) {
  const order = capture.access_orders?.find(row => row.status === "ordered" && !row.truncated);
  if (!order || order.total !== order.entries.length) throw new Error("complete field access order unavailable");
  const entries = order.entries.filter(entry => rootId(entry.target) !== null);
  if (entries.some(entry => !Number.isSafeInteger(entry.access_ordinal))) throw new Error("source access ordinal unavailable");
  const sorted = [...entries].sort((a, b) => a.access_ordinal - b.access_ordinal);
  const seen = new Set(), result = [];
  for (const entry of sorted) {
    const id = rootId(entry.target);
    if (!seen.has(id)) { seen.add(id); result.push(id); }
  }
  return result;
}

function recordedInputs(db, workspace, pages, pageMetadata) {
  const records = new Map(db.prepare("SELECT record_id, source_body, event_time, scope_class FROM source_records WHERE workspace_id=?")
    .all(workspace).map(row => [row.record_id, row]));
  const targets = new Map();
  for (const row of db.prepare("SELECT record_id, target_json FROM source_index_roots WHERE workspace_id=? AND root_kind='source_record'").all(workspace)) {
    if (targets.has(row.record_id)) throw new Error(`ambiguous indexed root: ${row.record_id}`);
    targets.set(row.record_id, JSON.parse(row.target_json));
  }
  const entries = new Map(), metadata = new Map();
  for (const frame of pageMetadata) for (const item of frame.entries) {
    const key = indexEntryCacheKey(item.entry);
    if (metadata.has(key) && !isDeepStrictEqual(metadata.get(key), item.metadata)) {
      throw new Error("ambiguous native source metadata");
    }
    metadata.set(key, item.metadata);
  }
  for (const page of pages) {
    if (!page.output?.index) continue;
    page.output.results.forEach((result, index) => {
      const id = rootId(result.target);
      if (id !== null) entries.set(id, page.output.index.entries[index]);
    });
  }
  return { records, targets, entries, metadata };
}

function createEncoder(inputs, pages) {
  const page = pages.find(item => item.output?.index && item.output.results.length > 0);
  if (!page) throw new Error("no captured page encoding template");
  const template = page.output.index, budget = page.output.results[0].budget_state.max_total_tokens;
  const previews = new Map(), metadata = {}, entries = new Map();
  const entryFor = (id, start = 0) => {
    const key = `${id}\0${start}`;
    if (entries.has(key)) return entries.get(key);
    const record = inputs.records.get(id), source = inputs.targets.get(id);
    if (!record || !source) throw new Error(`source not present in captured SQLite generation: ${id}`);
    authorizeSourceIndexScope(record.scope_class, source, ["project"]);
    const target = source.target;
    const bytes = Buffer.from(record.source_body, "utf8");
    if (!Number.isSafeInteger(start) || start < 0 || start > bytes.length || start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
      throw new Error(`invalid UTF-8 display start: ${id}`);
    }
    const text = bytes.subarray(start).toString("utf8");
    const preview = sourceDeliveryPrefix(text, value => Buffer.byteLength(value) <= budget);
    const base = inputs.entries.get(id);
    if (base === undefined || !inputs.metadata.has(indexEntryCacheKey(base))) {
      throw new Error(`native source metadata not captured for ${id}`);
    }
    const entry = { ...base, target: { ...target, span: { content_start: start,
      content_end: start + Buffer.byteLength(preview), retained_extent: "body",
      content_complete: preview === text, original_complete: false } } };
    const cacheKey = indexEntryCacheKey(entry);
    previews.set(cacheKey, preview);
    metadata[cacheKey] = structuredClone(inputs.metadata.get(indexEntryCacheKey(base)) ?? {});
    entries.set(key, entry);
    return entry;
  };
  const encode = selected => encodeIndexResults({ ...template, entries: selected,
    representation: { ...template.representation, page_budget: selected.length } }, previews, budget, metadata);
  return { entryFor, encode, width: page.request.max_results };
}

/** A display is a byte start per root; omitted starts retain the ordinary root prefix. */
export function simulateRecallDelivery(row, order, display = {}) {
  const pages = row.pool_capture?.pages;
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("captured page templates unavailable");
  if (!Array.isArray(order) || new Set(order).size !== order.length) throw new Error("policy order must contain unique roots");
  return withRecallSnapshot(row, snapshot => {
    const db = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
    const inputs = recordedInputs(db, row.workspace, pages, row.pool_capture.page_metadata ?? []), encoder = createEncoder(inputs, pages);
    const results = [];
    let cursor = 0, pagesUsed = 0;
    while (cursor < order.length && results.length < 10) {
      let width = Math.min(encoder.width, order.length - cursor);
      while (width > 0) {
        const selected = order.slice(cursor, cursor + width).map(id => encoder.entryFor(id, display[id] ?? 0));
        const encoded = encoder.encode(selected);
        if (encoded.length === 0) throw new Error("production encoder refused every selected root");
        if (encoded.length < width) { width = encoded.length; continue; }
        results.push(...encoded); cursor += width; pagesUsed++; break;
      }
    }
    return { pages: pagesUsed, metadata_scope: "captured_native",
      intervals: results.map((result, slot_index) => ({ slot_index, target: result.target, span: result.target.span })) };
    } finally { db.close(); }
  });
}
