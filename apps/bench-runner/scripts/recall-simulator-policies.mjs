// Historical label-free controls. Sibling/time/evidence-route expansions are diagnostic only.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { analyzeSourceIndexLexical, warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { AlayaError, hashContentDigest, splitFtsLanes } from "@do-soul/alaya-protocol";
import { authorizeSourceIndexScope, fieldContractSha256 } from "@do-soul/alaya-core";
import { buildFtsMatchExpression } from "../../../packages/storage/dist/repos/shared/fts-lane-routing.js";
import { observedAccessOrder } from "./recall-simulator-delivery.mjs";
import { loadRecallVectorCache } from "./recall-vector-cache.mjs";
import { withRecallSnapshot } from "./recall-bound-snapshot.mjs";
import { projectHostContainer } from "./recall-host-container.mjs";

const Database = createRequire(new URL("../package.json", import.meta.url))("better-sqlite3");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = text => createHash("sha256").update(text).digest("hex");
const spanKey = (workspace, root, start) => `${workspace}\0${root}\0${start}`;
const rootsOf = rows => [...new Set(rows.map(row => row.id))];
const clean = text => text.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();

export async function preparePolicyInputs(_capture, options) {
  const coordinates = new Map();
  if (options.coordinates) {
    for await (const line of createInterface({ input: createReadStream(options.coordinates), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (coordinates.has(row.question_id)) throw new AlayaError("CONFLICT", "duplicate frozen coordinates");
      coordinates.set(row.question_id, row);
    }
  }
  const statements = new Map();
  if (options.statements) {
    const view = JSON.parse(readFileSync(options.statements, "utf8"));
    if (!Array.isArray(view.entries)) throw new AlayaError("VALIDATION", "invalid statement view");
    for (const entry of view.entries) {
      const key = spanKey(entry.workspace, entry.root_id, entry.span?.[0]);
      if (statements.has(key)) throw new AlayaError("CONFLICT", "duplicate statement source span");
      statements.set(key, entry);
    }
  }
  return { coordinates, statements, vectors: await loadRecallVectorCache(options.vectorCache), contexts: new Map() };
}

function readContext(row) {
  return withRecallSnapshot(row, snapshot => {
    const db = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
    const sources = db.prepare(`SELECT r.record_id, r.source_body, r.event_time, r.scope_class,
      s.root_key, s.target_json, x.body AS index_body,
      h.canonical_inventory FROM source_records r JOIN source_index_roots s ON s.workspace_id=r.workspace_id AND s.record_id=r.record_id
      JOIN source_index_text x ON x.workspace_id=s.workspace_id AND x.root_key=s.root_key
      LEFT JOIN source_host_inventories h ON h.workspace_id=r.workspace_id AND h.record_id=r.record_id
      WHERE r.workspace_id=?`).all(row.workspace);
    const records = new Map(), messages = [], rounds = [];
    for (const source of sources) {
      try { authorizeSourceIndexScope(source.scope_class, JSON.parse(source.target_json), ["project"]); } catch { continue; }
      if (records.has(source.record_id)) throw new AlayaError("CONFLICT", `ambiguous indexed root: ${source.record_id}`);
      const occurrences = source.canonical_inventory === null ? [] : JSON.parse(source.canonical_inventory).occurrences;
      const container = projectHostContainer(occurrences).key;
      records.set(source.record_id, { container, event_time: source.event_time });
      rounds.push({ id: source.record_id, key: source.root_key, text: source.index_body });
      const bytes = Buffer.from(source.source_body, "utf8");
      for (const occurrence of occurrences) {
        const [start, end] = occurrence.utf8_span;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > bytes.length || end < start) {
          throw new AlayaError("VALIDATION", "invalid recorded message span");
        }
        messages.push({ id: source.record_id, key: `${source.root_key}\0m${String(start).padStart(8, "0")}`,
          start, end, text: bytes.subarray(start, end).toString("utf8") });
      }
    }
    return { records, messages, rounds };
    } finally { db.close(); }
  });
}

/** The historical message-unit control has its own temporary corpus; native root rankings remain separate. */
export async function messageFtsRanking(docs, query) {
  if (!await warmCjkSegmentation()) throw new AlayaError("UNAVAILABLE", "segmentation unavailable");
  const db = new Database(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE p USING fts5(projection, tokenize='unicode61'); CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram');");
    const unicode = db.prepare("INSERT INTO p(rowid, projection) VALUES(?,?)"), trigram = db.prepare("INSERT INTO t(rowid, body) VALUES(?,?)");
    docs.forEach((doc, index) => {
      unicode.run(index + 1, analyzeSourceIndexLexical(doc.text, "source")); trigram.run(index + 1, doc.text);
    });
    const split = splitFtsLanes(analyzeSourceIndexLexical(query, "query"));
    const lanes = [["p", split.porterTokens], ["t", split.trigramTokens]].filter(([, tokens]) => tokens.length > 0)
      .map(([table, tokens]) => db.prepare(`SELECT rowid AS id, bm25(${table}) AS score FROM ${table} WHERE ${table} MATCH ?`)
        .all(buildFtsMatchExpression(tokens)).map(result => ({ ...result, key: docs[result.id - 1].key }))
        .sort((a, b) => a.score - b.score || compare(a.key, b.key)));
    const result = [], offsets = lanes.map(() => 0), done = lanes.map(() => false);
    while (done.some(value => !value)) lanes.forEach((lane, index) => {
      if (done[index]) return;
      const item = lane[offsets[index]++];
      if (item === undefined) done[index] = true;
      else result.push(docs[item.id - 1]);
    });
    return result;
  } finally { db.close(); }
}

function statementDocs(row, native, context, statements) {
  const container = id => context.records.get(id)?.container ?? null;
  const top = new Set(native.intervals.filter(interval => interval.slot_index < 5).map(interval => container(interval.target.root_id)).filter(Boolean));
  const docs = [], inScope = [];
  for (const message of context.messages) {
    if (!top.has(container(message.id))) { docs.push(message); continue; }
    const entry = statements.get(spanKey(row.workspace, message.id, message.start));
    if (!entry || entry.span?.[1] !== message.end || entry.text_sha256 !== digest(message.text)) {
      throw new AlayaError("CONFLICT", "statement view does not bind a first-five-container source message");
    }
    if (!["represented", "valid_empty", "incomplete", "invalid", "unknown", "missing"].includes(entry.status)) {
      throw new AlayaError("VALIDATION", "unrecognized statement status");
    }
    if (entry.status === "represented") {
      if (!Array.isArray(entry.statements) || entry.statements.length === 0 || !entry.statements.every(text => typeof text === "string" && text.trim())) {
        throw new AlayaError("VALIDATION", "invalid represented statements");
      }
      entry.statements.forEach((text, index) => {
        const doc = { ...message, key: `${message.key}\0t${String(index).padStart(8, "0")}`, text };
        docs.push(doc); inScope.push(doc);
      });
    } else {
      if (entry.status === "valid_empty" ? !Array.isArray(entry.statements) || entry.statements.length !== 0 : entry.statements !== null) {
        throw new AlayaError("VALIDATION", "unavailable statements cannot be consumed");
      }
      docs.push(message); inScope.push(message);
    }
  }
  return { docs, inScope };
}

export function anchored(preferred, native, stream, records) {
  const first = native.intervals.filter(interval => interval.slot_index < 5).map(interval => interval.target.root_id);
  const container = id => records.get(id)?.container ?? null, used = new Set(), anchored = new Set(), head = [];
  for (const id of first) {
    const group = container(id);
    if (group === null || !anchored.has(group)) { if (group !== null) anchored.add(group); used.add(id); head.push(id); continue; }
    const selected = [...preferred, ...first].find(candidate => container(candidate) === group && !used.has(candidate));
    if (selected === undefined) throw new AlayaError("CONFLICT", "anchored container lacks an unused source");
    used.add(selected); head.push(selected);
  }
  return [...new Set([...head, ...first, ...stream])];
}

function vectorRanking(docs, evidence, profile, vectors) {
  const lookup = text => {
    const result = vectors.get(`${profile}\0${digest(text)}`);
    if (!result) throw new AlayaError("UNAVAILABLE", "required statement or question vector is not cached");
    return result;
  };
  const queries = evidence.map(lookup);
  const cosine = (a, b) => {
    if (a.length !== b.length) throw new AlayaError("CONFLICT", "cached vector dimensions differ");
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    if (!(aa > 0 && bb > 0)) throw new AlayaError("VALIDATION", "cached vector has zero norm");
    return dot / Math.sqrt(aa * bb);
  };
  return rootsOf(docs.map(doc => ({ ...doc, score: Math.max(...queries.map(query => cosine(lookup(doc.text), query))) }))
    .sort((a, b) => b.score - a.score || compare(a.key, b.key)));
}

export async function selectPolicy(name, row, native, inputs) {
  const stream = observedAccessOrder(row.pool_capture);
  const coordinate = inputs.coordinates.get(row.question_id);
  const fallback = reason => ({ status: "ready", order: stream, scope: `native_fallback:${reason}` });
  const unavailable = reason => ({ status: "unavailable", reason });
  if (!["msg-lex-global-anchor", "qh-vec-anchor", "qh-lex-anchor", "time", "qroute-ev"].includes(name)) {
    return unavailable(`unknown policy: ${name}`);
  }
  if (name !== "msg-lex-global-anchor" && (!coordinate || coordinate.status !== "formed")) return unavailable("frozen coordinates unavailable");
  const question = row.pool_capture.pages[0]?.request.query;
  if (typeof question !== "string") return unavailable("captured original question unavailable");
  const context = inputs.contexts.get(row.question_id) ?? readContext(row);
  inputs.contexts.set(row.question_id, context);
  const evidence = coordinate?.coordinates?.evidence_statements?.map(clean).filter(Boolean) ?? [];
  if (name === "qroute-ev") {
    if (evidence.length === 0) return fallback("valid_empty_evidence");
    const route = row.pool_capture.diagnostic_beyond_allowance?.rankings?.qroute_ev;
    if (route?.status !== "captured") return unavailable(route?.reason ?? "diagnostic evidence route unavailable");
    if (!isDeepStrictEqual(route.coordinates, coordinate.coordinates)
      || route.input_digest !== hashContentDigest(evidence.join(" "), fieldContractSha256)
      || route.generation_id !== row.pool_capture.generation?.generation_id
      || route.profile_id !== row.pool_capture.generation?.profile_id) return unavailable("evidence route does not bind the selected Q sample and generation");
    const order = [], seen = new Set();
    for (let index = 0; index < Math.max(stream.length, route.roots.length); index++) for (const id of [stream[index], route.roots[index]]) {
      if (id !== undefined && !seen.has(id)) { seen.add(id); order.push(id); }
    }
    return { status: "ready", order, scope: `diagnostic_beyond_allowance:evidence_route:${route.completion}` };
  }
  if (name === "time") {
    const time = coordinate.coordinates.time;
    if (time.kind !== "window" || time.alternatives.length === 0) return fallback("no_time_window");
    const inDomain = id => {
      const value = context.records.get(id)?.event_time;
      if (!value) return false;
      const day = new Date(value).toISOString().slice(0, 10);
      return time.alternatives.some(alternative => alternative.start <= day && day <= alternative.end);
    };
    const docs = context.rounds.filter(doc => inDomain(doc.id));
    if (docs.length === 0) return fallback("empty_time_domain");
    const ranking = rootsOf(await messageFtsRanking(docs, question));
    return { status: "ready", order: [...new Set([...stream.filter(inDomain), ...ranking, ...stream])],
      scope: "diagnostic_beyond_allowance:time_domain" };
  }
  if (native.intervals.some(interval => interval.slot_index < 5 && !context.records.get(interval.target.root_id)?.container)) {
    return unavailable("first-five host container unavailable or ambiguous");
  }
  let preferred, features;
  if (name === "msg-lex-global-anchor") {
    const ranked = await messageFtsRanking(context.messages, question);
    preferred = rootsOf(ranked);
    features = { diagnostic_message_lexical: ranked.map((doc, index) => ({ rank: index + 1,
      root_id: doc.id, message_key: doc.key, start: doc.start, end: doc.end })), root_order: preferred };
  }
  else {
    if (evidence.length === 0) return fallback("valid_empty_evidence");
    const views = statementDocs(row, native, context, inputs.statements);
    preferred = name === "qh-lex-anchor" ? rootsOf(await messageFtsRanking(views.docs, evidence.join(" ")))
      : vectorRanking(views.inScope, evidence, row.pool_capture.generation.profile_id, inputs.vectors);
  }
  return { status: "ready", order: anchored(preferred, native, stream, context.records), ...(features === undefined ? {} : { features }),
    scope: "diagnostic_beyond_allowance:first_five_container_siblings" };
}
