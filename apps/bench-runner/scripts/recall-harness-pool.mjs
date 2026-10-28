// Label-free source facts from the actual ordinary call and its sealed SQLite generation.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SourceIndexAcquisition, authorizeSourceIndexScope, fieldContractSha256 } from "@do-soul/alaya-core";
import { StorageDatabase, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { hashContentDigest } from "@do-soul/alaya-protocol";
import { readCjkSegmentationStatus, warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { withRecallSnapshot } from "./recall-bound-snapshot.mjs";
import { projectHostContainer } from "./recall-host-container.mjs";

const Database = createRequire(new URL("../package.json", import.meta.url))("better-sqlite3");
const keyOf = target => target?.kind === "source_evidence" ? target.root_id : null;
const listEvents = observation => observation.observations.flatMap(frame => frame.events.map(event => ({
  request_id: frame.request_id, binding: frame.facts?.binding ?? null, frame_status: frame.status,
  facts_complete: frame.facts?.complete === true,
  execution: frame.execution, issues: frame.issues, aggregates_complete: frame.aggregates_complete,
  dropped_events: frame.dropped_events, diagnostics: frame.diagnostics ?? null, ...event
})));

export function readInventory(db, workspace) {
  const records = db.prepare("SELECT record_id, source_id, source_body, event_time, scope_class FROM source_records WHERE workspace_id=?").all(workspace);
  const roots = db.prepare("SELECT root_key, record_id, target_json FROM source_index_roots WHERE workspace_id=? AND root_kind='source_record'").all(workspace);
  const inventories = new Map(db.prepare("SELECT record_id, canonical_inventory FROM source_host_inventories WHERE workspace_id=?")
    .all(workspace).map(row => [row.record_id, JSON.parse(row.canonical_inventory).occurrences]));
  const spans = db.prepare("SELECT record_id, start_offset, end_offset, purpose FROM source_spans WHERE workspace_id=? ORDER BY record_id, start_offset, end_offset")
    .all(workspace);
  const units = new Map();
  for (const span of spans) {
    if (!units.has(span.record_id)) units.set(span.record_id, []);
    units.get(span.record_id).push({ ...span, byte_size: span.end_offset - span.start_offset });
  }
  const byRoot = new Map();
  for (const root of roots) {
    if (byRoot.has(root.record_id)) throw new Error(`ambiguous indexed root: ${root.record_id}`);
    byRoot.set(root.record_id, JSON.parse(root.target_json));
  }
  const byId = new Map(records.flatMap(record => {
    const source = byRoot.get(record.record_id);
    if (source === undefined) return [];
    try { authorizeSourceIndexScope(record.scope_class, source, ["project"]); } catch { return []; }
    const occurrences = inventories.get(record.record_id) ?? [];
    const host = projectHostContainer(occurrences);
    return [[record.record_id, { ...record, root_key: source.root_key, target: source.target,
      container: host.key, container_ref: host.reference, container_status: host.status, position: host.position,
      occurrences, units: units.get(record.record_id) ?? [] }]];
  }));
  const containers = new Map();
  for (const value of byId.values()) {
    if (value.container === null || value.position === null) continue;
    if (!containers.has(value.container)) containers.set(value.container, []);
    containers.get(value.container).push(value);
  }
  for (const values of containers.values()) {
    values.sort((a, b) => a.position - b.position || a.record_id.localeCompare(b.record_id));
    values.forEach((row, round) => { row.round = round; });
  }
  return byId;
}

export function sourceFact(source) {
  if (source === undefined) return null;
  const roles = [...new Set(source.occurrences.map(occurrence => occurrence.role).filter(role => typeof role === "string"))];
  const unknown = source.occurrences.some(occurrence => typeof occurrence.role !== "string");
  return { root_id: source.record_id, root_key: source.root_key ?? null, target: source.target ?? null,
    source_id: source.source_id, body_bytes: Buffer.byteLength(source.source_body), event_time: source.event_time,
    container: source.container_ref ?? null, container_status: source.container_status ?? "unavailable",
    round: source.round ?? null, position: source.position,
    role: roles.length === 1 && !unknown ? roles[0] : null, roles,
    role_status: roles.length === 0 ? "unavailable" : unknown ? "partial" : roles.length === 1 ? "uniform" : "mixed",
    structural_units: source.units, occurrences: source.occurrences };
}

function activeFrame(event, workspace, asOf) {
  return event.binding?.workspace_id === workspace && event.binding?.as_of === asOf
    && event.binding?.operation === "recall" && event.frame_status === "observed" && event.execution === "success"
    && event.facts_complete && event.dropped_events === 0 && event.aggregates_complete && event.issues.length === 0;
}

export function matchedRole(window, host) {
  const span = window?.status === "available" ? window.window ?? window : window;
  const start = span?.start_byte, end = span?.end_byte;
  if (!host || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    return { status: "unavailable" };
  }
  const overlapping = host.occurrences.filter(occurrence => occurrence.utf8_span[0] < end && occurrence.utf8_span[1] > start);
  const roles = [...new Set(overlapping.map(occurrence => occurrence.role).filter(role => typeof role === "string"))];
  return roles.length === 0 ? { status: "unavailable" }
    : overlapping.some(occurrence => typeof occurrence.role !== "string") ? { status: "partial", roles } : roles.length === 1
    ? { status: "known", role: roles[0] } : { status: "mixed", roles };
}

function routeRows(events, inventory, witness) {
  const routes = {};
  for (const event of events.filter(row => row.kind === "source_index_acquisition")) {
    const fact = event.data;
    if (fact.kind !== "lexical_candidate" && fact.kind !== "vector_ranked") continue;
    const channel = fact.kind === "lexical_candidate" ? "lexical" : "vector";
    const name = `${fact.invocation}-${channel}`;
    const root = keyOf(fact.target), recorded = witness.find(item => item.view === fact.invocation
      && item.route.kind === channel && item.route.native_rank === fact.rank && keyOf(item.source.target) === root);
    if (!inventory.has(root)) continue;
    const window = fact.window ?? recorded?.route.window ?? recorded?.route.hit ?? null, host = sourceFact(inventory.get(root));
    (routes[name] ??= []).push({ rank: fact.rank, root_id: root, window, matched_role: matchedRole(window, host),
      lane: fact.lane ?? null, lane_rank: fact.lane_rank ?? null, host });
  }
  return routes;
}

export function diagnosticRanking(db, snapshot, workspace, question, vector, generation, inventory, coordinates, vectorCache, nativeIndex) {
  const unavailable = reason => ({ status: "unavailable", reason, diagnostic_beyond_allowance: true });
  if (vector?.status !== "available") return unavailable(vector?.reason ?? "native_query_vector_not_observed");
  if (generation === undefined || vector.profile_id !== generation.profile_id || vector.input_digest !== hashContentDigest(question, fieldContractSha256)
      || !Array.isArray(vector.embedding) || !vector.embedding.every(Number.isFinite)) return unavailable("query_vector_binding_mismatch");
  const nativeBinding = nativeIndex?.query_state?.binding;
  if (nativeIndex?.workspace_id !== workspace || nativeBinding?.generation_id !== generation.generation_id
    || nativeBinding?.profile_id !== generation.profile_id || nativeIndex.generation?.generation_id !== generation.generation_id
    || generation.config_id !== undefined && nativeBinding.config_id !== generation.config_id
    || generation.source_epoch !== undefined && nativeBinding.source_epoch !== generation.source_epoch
    || generation.selection_revision !== undefined && nativeBinding.selection_revision !== generation.selection_revision) {
    return unavailable("native_index_binding_mismatch");
  }
  if (readCjkSegmentationStatus() !== "ready") return unavailable("segmentation_unavailable");
  const nativeVector = { ...vector, embedding: Float32Array.from(vector.embedding) };
  const storage = new StorageDatabase(snapshot, db), repository = new SqliteSourceIndexRepository(storage, fieldContractSha256,
    { captureReadTargets: true });
  const acquisition = new SourceIndexAcquisition(repository, fieldContractSha256);
  const allowance = { max_attempts: 128, max_roots: 50, max_vector_windows: 4096 };
  const input = { workspace_id: workspace, navigation_text: question, vector: nativeVector, allowance };
  const read = db.transaction(() => {
    const capacity = repository.quoteQueryCapacity(workspace, allowance);
    const budget = SourceIndexAcquisition.quoteAllowanceBudget(input, capacity);
    const admit = (scope, source) => {
      try { authorizeSourceIndexScope(scope, source, ["project"]); return "admitted"; } catch { return "denied"; }
    };
    const ranking = acquisition.captureNative({ ...input, budget }, admit, "original", true, "dual");
    const excluded = { denied: 0, unavailable: 0 };
    const visible = (candidate, binding) => {
      const result = repository.admitQueryCandidate(candidate.source, binding, budget);
      if (result.status !== "ready") { excluded.unavailable++; return false; }
      if (admit(result.scope_class, candidate.source) !== "admitted") { excluded.denied++; return false; }
      return true;
    };
    const lexical = ranking.lexical.filter(item => item.lexical.rank <= 50 && visible(item, null));
    const vectorRows = ranking.vector.filter(item => item.vector.rank <= 50 && visible(item, ranking.binding));
    let qroute;
    try {
      const evidence = coordinates?.status === "formed" ? coordinates.coordinates.evidence_statements
        .map(text => text.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim()).filter(Boolean) : [];
      const text = evidence.join(" "), hash = createHash("sha256").update(text).digest("hex");
      const cached = vectorCache?.get(`${vector.profile_id}\0${hash}`);
      if (coordinates === undefined || coordinates.status !== "formed") qroute = { status: "unavailable", reason: "coordinates_unavailable" };
      else if (evidence.length === 0) qroute = { status: "valid_empty", roots: [] };
      else if (!cached) qroute = { status: "unavailable", reason: "evidence_route_vector_not_cached" };
      else {
        const routeInput = { ...input, navigation_text: text, vector: { ...nativeVector,
          input_digest: hashContentDigest(text, fieldContractSha256), embedding: cached },
          allowance: { ...allowance, max_roots: 16 } };
        const routeBudget = SourceIndexAcquisition.quoteAllowanceBudget(routeInput,
          repository.quoteQueryCapacity(workspace, routeInput.allowance));
        const route = acquisition.nominateWithWitness({ ...routeInput, budget: routeBudget }, admit, "original");
        const routeBinding = route.result.vector.state?.binding;
        qroute = isDeepStrictEqual(routeBinding, nativeBinding)
          ? { status: "captured", completion: route.result.completion, resources: route.result.resources,
            generation_id: nativeBinding.generation_id, profile_id: nativeBinding.profile_id,
            input_digest: routeInput.vector.input_digest, coordinates: coordinates.coordinates,
            roots: route.result.nominations.map(item => item.source.target.root_id) }
          : { status: "unavailable", reason: "evidence_route_generation_mismatch" };
      }
    } catch (error) { qroute = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
    return { ranking, lexical, vectorRows, qroute, excluded };
  })();
  if (!isDeepStrictEqual(read.ranking.binding, nativeBinding)) return unavailable("diagnostic_generation_mismatch");
  const map = (row, rank, detail) => ({ rank, root_id: row.source.target.root_id, root_key: row.source.root_key,
    ...detail, host: sourceFact(inventory.get(row.source.target.root_id)) });
  return { status: "captured", diagnostic_beyond_allowance: true, generation_id: generation.generation_id,
    lexical_completion: read.ranking.result.lexical.completion, lexical_reason: read.ranking.result.lexical.reason,
    vector_completion: read.ranking.result.vector.completion, vector_reason: read.ranking.result.vector.reason,
    vector_ranking: read.ranking.result.vector.ranking, inspected_windows: read.ranking.result.vector.inspected_windows,
    qroute_ev: read.qroute, excluded: read.excluded,
    lexical: read.lexical.map(row => map(row, row.lexical.rank,
      { lane: row.lexical.lane, lane_rank: row.lexical.lane_rank })),
    vector: read.vectorRows.map(row => map(row, row.vector.rank,
      { window: row.vector.window, matched_role: matchedRole(row.vector.window, sourceFact(inventory.get(row.source.target.root_id))),
        cosine: row.vector.cosine })) };
}

/** No labels or answer text are accepted by this boundary. */
export async function captureRecallPool({ row, query, observation, generation, coordinates, vectorCache }) {
  if (observation === undefined) return { status: "unavailable", issues: ["ordinary_observation_missing"] };
  if (query.pages[0]?.request.scope_class !== "project") return { status: "unavailable", issues: ["unsupported_scope"] };
  if (observation.observations.some(frame => frame.events.some(event =>
    event.kind === "source_query_vector" && event.data?.status === "available"))) await warmCjkSegmentation();
  return withRecallSnapshot(row, snapshot => {
    const db = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
    const inventory = readInventory(db, row.workspace), allEvents = listEvents(observation);
    const events = allEvents.filter(event => activeFrame(event, row.workspace, query.snapshot_identity?.as_of));
    const rejected = observation.observations.filter(frame => (frame.execution !== "success" || frame.events.some(event =>
      event.kind === "field_nomination" || event.kind === "field_access_order" || event.kind === "source_index_routes"
        || event.kind === "field_page_metadata" || event.kind === "field_page_attempt"))
      && !frame.events.some(event => activeFrame({ ...event, binding: frame.facts?.binding ?? null,
        frame_status: frame.status, execution: frame.execution, facts_complete: frame.facts?.complete === true,
        dropped_events: frame.dropped_events,
        aggregates_complete: frame.aggregates_complete, issues: frame.issues }, row.workspace, query.snapshot_identity?.as_of)))
      .map(frame => ({ request_id: frame.request_id, status: frame.status, execution: frame.execution,
        binding: frame.facts?.binding ?? null, fact_issues: frame.facts?.issues ?? null,
        issues: frame.issues, dropped_events: frame.dropped_events }));
    const nomination = events.find(event => event.kind === "field_nomination")?.data;
    const witness = nomination?.witness ?? [];
    const nominated = nomination?.result?.nominations ?? [];
    const issues = [];
    if (observation.status !== "available") issues.push(`scope_${observation.status}`);
    if (rejected.length > 0) issues.push("ordinary_capture_frame_rejected");
    if (nomination === undefined) issues.push("field_nomination_not_observed");
    else if (nomination.result === null) issues.push("native_nomination_unavailable");
    if (nominated.length > 16) issues.push("native_nomination_exceeds_bound");
    if (nominated.some(item => !inventory.has(item.source.target.root_id))) issues.push("nominated_root_metadata_unavailable");
    if (events.some(event => event.dropped_events > 0)) issues.push("native_progress_events_dropped");
    const rankKinds = ["lexical_candidate", "vector_ranked"].flatMap(kind => ["original", "hint"].map(view => `source_index_${view}_${kind}`));
    if (events.some(event => rankKinds.some(kind => (event.diagnostics?.omitted_counts?.[kind] ?? 0) > 0))) {
      issues.push("native_route_rank_detail_overflow");
    }
    if (events.some(event => event.kind === "source_index_acquisition"
      && ["lexical_candidate", "vector_ranked"].includes(event.data.kind) && !inventory.has(keyOf(event.data.target)))) {
      issues.push("native_route_rank_target_filtered_or_unavailable");
    }
    const orders = events.filter(event => event.kind === "field_access_order").map(event => ({
      request_id: event.request_id, ...event.data }));
    const pageMetadata = events.filter(event => event.kind === "field_page_metadata").map(event => ({
      request_id: event.request_id, ...event.data }));
    const attemptEvents = events.filter(event => event.kind === "field_page_attempt");
    const pageAttempts = pageMetadata.map(page => ({ request_id: page.request_id,
      attempts: attemptEvents.filter(event => event.request_id === page.request_id).map(event => event.data) }));
    const observedPages = query.pages.filter(page => page.observation === "observed");
    if (orders.length === 0) issues.push("field_access_order_not_observed");
    if (pageMetadata.length === 0) issues.push("field_page_metadata_not_observed");
    if (pageAttempts.length !== observedPages.length || pageAttempts.some(page => page.attempts.length === 0)
      || attemptEvents.some(event => !pageMetadata.some(page => page.request_id === event.request_id))) {
      issues.push("field_page_attempts_incomplete");
    }
    if (orders.some(order => order.truncated || order.status !== "ordered" || !Array.isArray(order.entries)
      || order.total !== order.entries.length)) issues.push("field_access_order_incomplete");
    const selected = new Set(nominated.map(item => item.source.target.root_id));
    const firstRoots = query.source_intervals.filter(item => item.slot_index < 5).map(item => keyOf(item.target));
    const missingContainers = firstRoots.filter(id => !inventory.get(id)?.container);
    const firstContainers = new Set(firstRoots.map(id => inventory.get(id)?.container).filter(Boolean));
    const siblings = [...inventory.values()].filter(item => firstContainers.has(item.container) && !selected.has(item.record_id));
    const vector = events.find(event => event.kind === "source_query_vector" && event.data.status === "available")?.data;
    const nativeIndex = events.find(event => event.kind === "field_nomination")?.binding?.index ?? null;
    let diagnostic;
    try { diagnostic = diagnosticRanking(db, snapshot, row.workspace, query.original_query, vector, generation,
      inventory, coordinates, vectorCache, nativeIndex); }
    catch (error) { diagnostic = { status: "unavailable", diagnostic_beyond_allowance: true,
      reason: error instanceof Error ? error.message : String(error) }; }
    return { status: issues.length ? "partial" : "captured", issues, observation_status: observation.status,
      source_revision: query.snapshot_identity, generation, routes: routeRows(events, inventory, witness),
      route_phases: events.filter(event => event.kind === "source_index_routes").map(event => event.data),
      pool: nominated.map(item => ({ ...item, host: sourceFact(inventory.get(item.source.target.root_id)) })), rejected_frames: rejected,
      access_orders: orders, page_metadata: pageMetadata, page_attempts: pageAttempts, witness,
      diagnostic_beyond_allowance: { rankings: diagnostic, sibling_scope: "first_five_containers",
        sibling_scope_status: missingContainers.length ? "partial" : "complete", missing_container_roots: missingContainers,
        siblings: siblings.map(sourceFact), native_work: "not_measured" },
      observation_limits: events.map(event => ({ request_id: event.request_id, dropped_events: event.dropped_events,
        diagnostics: event.diagnostics })).filter((row, index, rows) => rows.findIndex(other => other.request_id === row.request_id) === index),
      pages: observedPages.map(page => ({
        request: page.request, output: page.output, occupied_slots: page.occupied_slots })) };
    } finally { db.close(); }
  });
}
