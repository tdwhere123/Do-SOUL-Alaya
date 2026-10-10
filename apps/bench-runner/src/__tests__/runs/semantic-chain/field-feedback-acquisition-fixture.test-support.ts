import {
  buildSourceReferenceCatalog, hashContentDigest, hashSourceRecordId, normalizeSourceSemantics,
  sourceReferenceResolver, sourceSemanticInterpretationIdentity, UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceReferenceCatalog, type SourceSemanticDraft, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { indexSourceSemanticUnits } from "@do-soul/alaya-soul";
import { bindSourceSemanticLocations } from
  "../../../../../../packages/core/src/memory/evidence-create/source-semantic-location.js";
import { accessQuery, ACCESS_BUDGET, CLOCK, WS, type AccessFixtureSource } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { receiveAuthoredCorrespondence } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { ARMS, type Action, type Arm, type Descriptor } from "./field-obligation-rediscovery.test-support.js";

export const ORIGINAL_QUERY = "Which package was shipped and checked?";
export const QUERY: SourceSemanticQuery = { ...accessQuery(ORIGINAL_QUERY),
  variables: [{ id: "package", sort: "entity" }, { id: "shipment", sort: "proposition" }, { id: "check", sort: "proposition" }],
  alternatives: [{ frames: [{ id: "shipping", variable: "shipment", predicate_reading: "shipped" },
    { id: "checking", variable: "check", predicate_reading: "checked" }].map(frame => ({ ...frame,
    role_requirements: [{ id: "object", role_reading: "object", target_variable: "package",
      support: { kind: "query_text" as const, excerpt: "package" } }] })),
    context_obligations: ["shipping", "checking"].map(frame => ({ frame, kind: "asserted_at_source" as const })) }],
  return_variables: ["package"] };
export const CELLS = [
  { name: "S-LQ", initial: "S", order: "LQ" }, { name: "S-QL", initial: "S", order: "QL" },
  { name: "K-LQ", initial: "K", order: "LQ" }, { name: "K-QL", initial: "K", order: "QL" }
] as const;
export type Cell = typeof CELLS[number];
export const POINTS = [
  { point: 1, work_units: 100_000, memory_bytes: 2_000_000 },
  { point: 2, work_units: 200_000, memory_bytes: 4_000_000 },
  { point: 3, work_units: 400_000, memory_bytes: 8_000_000 },
  { point: 4, work_units: 800_000, memory_bytes: 16_000_000 }
] as const;
export type Point = typeof POINTS[number];
export type Slot = { id: string; cell: Cell; point: Point; arm: Arm };
export const SLOTS: readonly Slot[] = CELLS.flatMap(cell => POINTS.flatMap(point => ARMS.map(arm => ({
  id: `${cell.name}-p${point.point}-${arm}`, cell, point, arm
}))));
export const PUBLICATION_BUDGET = { work_units: 1_048_576, memory_bytes: 134_217_728 };
export const COMMON_BUDGET = ACCESS_BUDGET;
export const REASON_BUDGET = { ...ACCESS_BUDGET, work_units: 200_000, memory_bytes: 20_000_000 };
export const SCOPES = { mode: "named" as const, scopes: ["project"] };
export const KNOWN_INITIAL_SOURCE = "parcel-register/document-00";
export const BASELINE_HINT = "package shipment shipped checking checked";
export const COMMON_RESERVATION = { work_units: 31_101_576, memory_bytes: 736_414_336 };
export const HOST_COMMON_CHARGES = { bootstrap: [1_000, 65_536], input_read: [1_000, 65_536],
  manifest_read: [1_000, 65_536], frozen_semantics: [50_000, 2_000_000] };

export function accessBudget(slot: Slot) {
  return { ...ACCESS_BUDGET, work_units: slot.point.work_units + (slot.arm === "F" ? 0 : 100_500),
    memory_bytes: slot.point.memory_bytes + (slot.arm === "F" ? 0 : 10_032_768) };
}
export function postForkReservation(point: Point) {
  return { work_units: 2 * point.work_units + 203_000, memory_bytes: 2 * point.memory_bytes + 20_196_608 };
}
export function allowance(point: Point) {
  const post = postForkReservation(point);
  return { total_work_units: COMMON_RESERVATION.work_units + post.work_units,
    total_memory_bytes: COMMON_RESERVATION.memory_bytes + post.memory_bytes,
    read_work_units: 1_000, read_memory_bytes: 65_536, max_input_bytes_per_read: 33_554_432,
    max_read_admissions: 64, max_effects: 64 };
}

export function sourceInputs(cell: Cell) {
  const initial = cell.initial === "S"
    ? "Package T7 was shipped. Mira promised to check T7. Shipping records are under Linden. Checking records are under Quartz."
    : "Package T7 was checked. Mira promised to ship T7. Shipping records are under Linden. Checking records are under Quartz.";
  const linden = cell.initial === "S" ? "Linden: Package T7 was shipped."
    : "Linden: Package T7 was shipped. Package T7 was checked.";
  const quartz = cell.initial === "K" ? "Quartz: Package T7 was checked."
    : "Quartz: Package T7 was shipped. Package T7 was checked.";
  const bodies = [initial, ...Array.from({ length: 30 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    return `Shipping notice R${ordinal}. Package P${ordinal} was shipped. A completed check is not recorded in this notice.`;
  }), ...(cell.order === "LQ" ? [linden, quartz] : [quartz, linden])];
  return bodies.map((text, ordinal) => {
    const at = new Date(Date.parse("2026-09-17T23:59:00.000Z") + ordinal * 1_000).toISOString();
    return { id: `parcel-register/document-${String(ordinal).padStart(2, "0")}`, text,
      recordedAt: at, publicationAt: at, verbatim: true as const, scope: "project" as const };
  });
}

/** These authored readings preserve source scope; absence of a record never asserts a failed check. */
export function parcelDraft(catalog: SourceReferenceCatalog): SourceSemanticDraft {
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const mentions: SourceSemanticDraft["mentions"][number][] = [], frames: SourceSemanticDraft["frames"][number][] = [];
  const referents = new Map<string, string[]>(), gaps: SourceSemanticDraft["gaps"][number][] = [];
  const mention = (assertion: number, text: string, excerpt: string, id: string) => {
    const start = text.indexOf(excerpt);
    if (start < 0) throw new Error(`authored excerpt is absent: ${excerpt}`);
    mentions.push({ id, assertion_id: assertion,
      source_ref: resolver.referenceForSpan(assertion, [start, start + excerpt.length]) });
    return id;
  };
  const gap = (assertion: number, text: string, excerpt: string, label: string) => {
    const id = mention(assertion, text, excerpt, `${label}${assertion}`);
    gaps.push({ kind: "uninterpreted_clause", affected_ids: [id], support: [{ kind: "lexical", mentions: [id] }],
      description: label === "missingRecord" ? "A completed check is not recorded in this notice; its occurrence remains unestablished."
        : "Exact source metadata or navigation text is retained without event or identity meaning." });
  };
  for (const assertion of catalog.assertions) {
    const text = assertion.segments.map(segment => segment.text).join(""), id = assertion.assertion_id;
    const title = /^(Linden|Quartz):/u.exec(text)?.[1];
    if (title !== undefined) gap(id, text, title, "title");
    if (text.includes("records are under")) { gap(id, text, text, "navigation"); continue; }
    if (text.includes("not recorded in this notice")) { gap(id, text, text, "missingRecord"); continue; }
    const item = /\b(T7|P\d{2})\b/u.exec(text)?.[1];
    if (item === undefined) { gap(id, text, text, "notice"); continue; }
    const promised = text.includes("promised"), frame = /\b(shipped|ship)\b/u.test(text) ? "ship" : "check";
    const word = frame === "ship" ? promised ? "ship" : "shipped" : promised ? "check" : "checked";
    const predicate = mention(id, text, word, `${frame}Predicate`), object = mention(id, text, item, `${frame}Item`);
    const node = `package${item}`;
    referents.set(node, [...(referents.get(node) ?? []), object]);
    frames.push({ id: frame, assertion_ids: [id], context_owner: promised
      ? { kind: "embedding", parent_frame: "promise", content_argument: frame }
      : { kind: "source_act", source_act: "assertion" }, additional_support: [],
    predicate_support: { kind: "explicit", reading: frame, mentions: [predicate] },
    slots: [{ id: "object", role_reading: "object", support: [{ kind: "lexical", mentions: [object] }] }],
    bindings: [{ slot_id: "object", target: { kind: "node", id: node }, support: [] }] });
    if (promised) {
      const who = mention(id, text, "Mira", "promisorMention"), promise = mention(id, text, "promised", "promisePredicate");
      referents.set("promisor", [who]);
      frames.push({ id: "promise", assertion_ids: [id], context_owner: { kind: "source_act", source_act: "assertion" },
        additional_support: [], predicate_support: { kind: "explicit", reading: "promise", mentions: [promise] },
        slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: [who] }] },
          { id: "content", role_reading: "content", support: [{ kind: "lexical", mentions: [predicate] }] }],
        bindings: [{ slot_id: "agent", target: { kind: "node", id: "promisor" }, support: [] },
          { slot_id: "content", target: { kind: "node", id: frame }, support: [] }] });
    }
  }
  return { contract: "source-interpretation-v4", mentions, frames, operators: [], gaps,
    referents: [...referents].map(([id, mentions]) => ({ id, referent_kind: "grouped", mentions })) };
}

export function nativeSources(cell: Cell): readonly AccessFixtureSource[] {
  return sourceInputs(cell).map(source => ({ ...source, authoredDraft: parcelDraft }));
}

function frozenSource(source: ReturnType<typeof sourceInputs>[number]) {
  const units = indexSourceSemanticUnits(source.text), content_digest = hashContentDigest(source.text, fieldContractSha256);
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(source.text), units.map(({ assertion_id, text }) => ({ assertion_id, text })), fieldContractSha256);
  const binding = { source_id: source.id, source_version: "1", content_digest, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION };
  const draft = parcelDraft(catalog);
  const normalized = normalizeSourceSemantics({ draft, catalog, source: binding, sha256: fieldContractSha256,
    producer_id: "access-test-author", producer_version: "p0", contract_version: "source-interpretation-v4" });
  if (normalized.status !== "normalized") throw new Error(`frozen source normalization failed: ${JSON.stringify(normalized)}`);
  const interpretation = bindSourceSemanticLocations({ source: source.text, interpretation: normalized.interpretation, catalog,
    sha256: fieldContractSha256, locations: units.map(unit => ({ assertion_id: unit.assertion_id,
      source_utf8_span: [Buffer.byteLength(source.text.slice(0, unit.start)), Buffer.byteLength(source.text.slice(0, unit.end))] })) });
  return { ...source, source_id: source.id, source_version: "1", content_digest,
    record_id: hashSourceRecordId(binding, fieldContractSha256), event_time: null, scope_class: "project",
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, catalog, draft, interpretation,
    interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256) };
}

export function initialCorrespondence(descriptor: Pick<Descriptor, "interpretation_id" | "interpretation">) {
  const h = descriptor.interpretation;
  if (h === undefined) throw new Error("initial correspondence requires the frozen H");
  const correspondences = [{ query: "shipping", source: "ship", excerpt: "shipped" },
    { query: "checking", source: "check", excerpt: "checked" }].flatMap(({ query, source, excerpt }) => {
    const frame = h.frames.find(row => row.id === source && row.predicate_support.reading === source);
    if (frame === undefined || frame.predicate_support.kind !== "explicit") throw new Error("initial event is missing");
    return [{ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: query },
      source_endpoint: { kind: "frame", frame: source }, query_support: { kind: "query_text", excerpt },
      source_semantic_support: [{ kind: "lexical", mentions: frame.predicate_support.mentions }] },
    { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: query, slot: "object" },
      source_endpoint: { kind: "slot", frame: source, slot: "object" }, query_support: { kind: "query_text", excerpt: "package" },
      source_semantic_support: frame.slots.find(row => row.id === "object")!.support }];
  });
  const received = receiveAuthoredCorrespondence({ original_query: ORIGINAL_QUERY, admitted_query_semantics: QUERY,
    source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: h }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences });
  if (received.semantic_correspondence === undefined) throw new Error("initial authored correspondence was not admitted");
  return received.semantic_correspondence;
}

export function frozenCell(cell: Cell) {
  const sources = sourceInputs(cell).map(frozenSource), initial = sources[0]!;
  const actions: Action[] = [{ frame: "shipping", hint: "Linden", label: "Shipping" },
    { frame: "checking", hint: "Quartz", label: "Checking" }].map(({ frame, hint, label }) => {
    const quote = `${label} records are under ${hint}.`, start = initial.text.indexOf(quote);
    if (start < 0) throw new Error("navigation action is not bound to initial source bytes");
    return { frame, alternative: 0, obligation: "context", access_hint: hint, support: {
      source_id: initial.source_id, source_version: initial.source_version, content_digest: initial.content_digest, quote,
      utf8_span: [Buffer.byteLength(initial.text.slice(0, start)), Buffer.byteLength(initial.text.slice(0, start + quote.length))] } };
  });
  const sufficientTitle = cell.initial === "S" ? "Quartz" : "Linden";
  const sufficient = sources.find(row => row.text.startsWith(`${sufficientTitle}:`))!;
  return { cell, sources, query: QUERY, initial_correspondence: initialCorrespondence(initial), actions,
    assessment_only: { expected_hint: sufficientTitle, sufficient_source_id: sufficient.source_id,
      sufficient_source_body: sufficient.text, sufficient_record_id: sufficient.record_id,
      sufficient_interpretation_id: sufficient.interpretation_id, asserted_answer: "T7", cross_source_join: false } };
}
export type FrozenCell = ReturnType<typeof frozenCell>;

/** Pure preregistration material; this function performs no publication, worker call or provider operation. */
export function acquisitionManifest(binding: { implementation_revision: string; implementation_tree: string }) {
  return { contract: "field-feedback-acquisition-curve-v1", ...binding, original_query: ORIGINAL_QUERY, query: QUERY,
    clock: CLOCK, workspace_id: WS, scopes: SCOPES, cells: CELLS.map(frozenCell), slots: SLOTS,
    arms: ARMS, points: POINTS, common_budget: COMMON_BUDGET, publication_budget: PUBLICATION_BUDGET,
    reason_budget: REASON_BUDGET, baseline_hint: BASELINE_HINT, output_byte_limit: 1_000_000,
    common_reservation: COMMON_RESERVATION, common_host_charges: HOST_COMMON_CHARGES,
    allowances: POINTS.map(point => ({ point: point.point, allowance: allowance(point), post_fork: postForkReservation(point) })),
    setup_failure_policy: "retain_failed_slot_and_continue_independent_registered_slots",
    native_isolation: "fresh_database_worker_allowance_and_handles_per_slot",
    unknown_costs: { common: "C0(cell): source admission and authored construction", policy: "U_arm: host selection and serialization" },
    no_post_fork_H_or_C_production: true, final_reason_or_reader: "not_exercised", provider_attempts: 0 };
}
