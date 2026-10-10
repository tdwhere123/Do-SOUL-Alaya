import { DatabaseSync } from "node:sqlite";
import { SourceSemanticPublishedInterpretationSchema, sourceReferenceResolver, sourceSemanticCorrespondenceIdentity,
  sourceSemanticQueryIdentity, type SourceReferenceCatalog, type SourceSemanticDraft, type SourceSemanticInterpretation,
  type SourceSemanticCorrespondence, type SourceSemanticReasoningResult, type SourceSemanticAccessReceipt,
  type SoulInterpretationResponse } from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { accessQuery, type AccessFixtureSource } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { receiveAuthoredCorrespondence } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";

export const ORIGINAL_QUERY = "Which consignment was dispatched and examined?";
export const QUERY = { ...accessQuery(ORIGINAL_QUERY),
  variables: [{ id: "item", sort: "entity" as const }, { id: "sentEvent", sort: "proposition" as const },
    { id: "inspectedEvent", sort: "proposition" as const }],
  alternatives: [{ frames: [{ id: "dispatch", variable: "sentEvent", predicate_reading: "dispatched" },
    { id: "examine", variable: "inspectedEvent", predicate_reading: "examined" }].map(frame => ({ ...frame,
      role_requirements: [{ id: "object", role_reading: "object", target_variable: "item",
        support: { kind: "query_text" as const, excerpt: "consignment" } }] })),
    context_obligations: ["dispatch", "examine"].map(frame => ({ frame, kind: "asserted_at_source" as const })) }],
  return_variables: ["item", "sentEvent", "inspectedEvent"] };
export const ALLOWANCE = { total_work_units: 2_000_000, total_memory_bytes: 80_000_000,
  read_work_units: 1_000, read_memory_bytes: 65_536, max_input_bytes_per_read: 33_554_432,
  max_read_admissions: 64, max_effects: 64 };
export const BUDGETS = { common: budget(200_000, 4_000_000), baseline: budget(300_000, 14_000_000),
  reasoning: budget(200_000, 20_000_000) };
export const SCHEDULE = { bootstrap: [1_000, 65_536], common_read: [1_000, 65_536], setup: [200_000, 8_000_000],
  manifest_read: [1_000, 65_536], frozen_semantics_and_reference: [50_000, 2_000_000],
  initial_preparation: [200_000, 4_000_000], initial_delivery: [200_000, 4_000_000],
  known_initial_source_preparation: [200_000, 4_000_000], initial_reason_F: [200_000, 20_000_000],
  candidate_selection_read: [1_000, 65_536], second_preparation_F: [200_000, 4_000_000],
  second_delivery_F: [200_000, 4_000_000], second_preparation_ABM: [300_000, 14_000_000],
  second_delivery_ABM: [300_000, 14_000_000], returned_correspondence: [50_000, 2_000_000],
  final_reason: [200_000, 20_000_000], assessment_read: [1_000, 65_536], output: [1_000, 65_536] };
export const ARMS = ["A", "B", "M", "F"] as const;
export type Arm = typeof ARMS[number];
export const CASES = [
  { name: "dispatch-known", initial: "Cargo J9 was sent. Vega promised to inspect J9. Dispatch records are under Cedar. Inspection records are under Harbor.",
    dispatch: "Cedar: cargo J9 was sent.", examine: "Harbor: cargo J9 was sent. Cargo J9 was inspected.",
    hints: ["Cedar", "Harbor"], expected_hint: "Harbor", expected_positive: "harbor" },
  { name: "inspection-known", initial: "Cargo J9 was inspected. Orion promised to send J9. Dispatch records are under Cedar. Inspection records are under Harbor.",
    dispatch: "Cedar: cargo J9 was sent. Cargo J9 was inspected.", examine: "Harbor: cargo J9 was inspected.",
    hints: ["Cedar", "Harbor"], expected_hint: "Cedar", expected_positive: "cedar" },
  { name: "split-item", initial: "Cargo K4 was sent. Vega promised to inspect K4. Dispatch records are under Birch. Inspection records are under Estuary.",
    dispatch: "Birch: cargo K4 was sent.", examine: "Estuary: cargo K4 was sent. Cargo K5 was inspected.",
    hints: ["Birch", "Estuary"], expected_hint: "Estuary", expected_positive: null }
] as const;
export type Fixture = typeof CASES[number];
export type Preparation = Extract<SoulInterpretationResponse, { operation: "prepare_query" }>;
export type SourcePreparation = Extract<SoulInterpretationResponse, { operation: "prepare_source" }>;
export type Delivery = Extract<SoulInterpretationResponse, { operation: "recall" }>;
export type Descriptor = Preparation["candidates"][number];
export type ManifestSource = { source_id: string; record_id: string; source_version: string; content_digest: string; source_body: string };
export type Action = { frame: "dispatch" | "examine"; alternative: 0; obligation: "context"; access_hint: string;
  support: { source_id: string; source_version: string; content_digest: string; quote: string; utf8_span: [number, number] } };

function budget(work_units: number, memory_bytes: number) {
  return { schema_version: 1 as const, work_units, memory_bytes, page_budget: 100_000,
    finalization_reserve: 10_000, min_envelope: 10 };
}
export function executionBinding(revision: string | undefined) {
  if (revision === undefined) return { implementation_revision: null, execution_kind: "unbound_test" } as const;
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("ALAYA_FIELD_REDISCOVERY_IMPLEMENTATION_REVISION requires 40 lowercase hex characters");
  return { implementation_revision: revision, execution_kind: "bound_experiment" } as const;
}

/** Authored source semantics, independent of the access policy and every native result. */
function eventDraft(catalog: SourceReferenceCatalog): SourceSemanticDraft {
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const mentions: SourceSemanticDraft["mentions"][number][] = [], frames: SourceSemanticDraft["frames"][number][] = [];
  const referents = new Map<string, string[]>(), gaps: SourceSemanticDraft["gaps"][number][] = [];
  const mention = (assertion: number, text: string, excerpt: string, id: string) => {
    const start = text.indexOf(excerpt);
    if (start < 0) throw new Error(`missing authored excerpt ${excerpt}`);
    mentions.push({ id, assertion_id: assertion, source_ref: resolver.referenceForSpan(assertion, [start, start + excerpt.length]) });
    return id;
  };
  for (const assertion of catalog.assertions) {
    const text = assertion.segments.map(segment => segment.text).join(""), id = assertion.assertion_id;
    if (text.includes("records are under")) {
      const m = mention(id, text, text, `navigation${id}`);
      gaps.push({ kind: "uninterpreted_clause", affected_ids: [m], support: [{ kind: "lexical", mentions: [m] }],
        description: "The raw navigation clue is retained but does not assert a dispatch or inspection event." });
      continue;
    }
    const match = /\b(J9|K4|K5)\b/u.exec(text);
    if (match === null) throw new Error("missing authored cargo identity");
    const promised = text.includes("promised"), frame = /\b(sent|send)\b/u.test(text) ? "send" : "inspect";
    const word = frame === "send" ? (promised ? "send" : "sent") : (promised ? "inspect" : "inspected");
    const predicate = mention(id, text, word, `${frame}Predicate`), item = mention(id, text, match[1]!, `${frame}Item`);
    const node = `item${match[1]}`;
    referents.set(node, [...(referents.get(node) ?? []), item]);
    frames.push({ id: frame, assertion_ids: [id], context_owner: promised
      ? { kind: "embedding", parent_frame: "promise", content_argument: frame }
      : { kind: "source_act", source_act: "assertion" }, additional_support: [],
      predicate_support: { kind: "explicit", reading: frame, mentions: [predicate] },
      slots: [{ id: "object", role_reading: "object", support: [{ kind: "lexical", mentions: [item] }] }],
      bindings: [{ slot_id: "object", target: { kind: "node", id: node }, support: [] }] });
    if (promised) {
      const actor = text.includes("Vega") ? "Vega" : "Orion";
      const who = mention(id, text, actor, "promisorMention"), promise = mention(id, text, "promised", "promisePredicate");
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

export function fixtureSources(fixture: Fixture): readonly AccessFixtureSource[] {
  const semantic = (suffix: string, text: string) => ({ id: `${fixture.name}/${suffix}`, text, verbatim: true, authoredDraft: eventDraft });
  return [semantic("initial", fixture.initial),
    semantic(fixture.hints[0].toLowerCase(), fixture.dispatch), semantic(fixture.hints[1].toLowerCase(), fixture.examine)];
}

export function readHealthyManifest(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const sources = db.prepare("SELECT source_id, record_id, source_version, content_digest, source_body FROM source_records ORDER BY rowid").all() as ManifestSource[];
    const publications = db.prepare("SELECT gist FROM evidence_capsules ORDER BY created_at, object_id").all()
      .map(row => SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(String(row.gist))));
    const capsule_metadata = db.prepare("SELECT object_id, source_hash, created_at, lifecycle_state FROM evidence_capsules ORDER BY created_at, object_id").all();
    return { sources, publications, capsule_metadata, conditioning: "none" as const };
  } finally { db.close(); }
}

export function correspondence(descriptor: Pick<Descriptor, "interpretation_id" | "interpretation">): SourceSemanticCorrespondence {
  const h = descriptor.interpretation;
  if (h === undefined) throw new Error("returned H body is required before C binding");
  const correspondences = [{ query: "dispatch", source: "send", excerpt: "dispatched" },
    { query: "examine", source: "inspect", excerpt: "examined" }].flatMap(({ query, source, excerpt }) => {
      const frame = h.frames.find(row => row.id === source && row.predicate_support.reading === source);
      if (frame === undefined) return [];
      const predicate = frame.predicate_support;
      if (predicate.kind !== "explicit") throw new Error("authored source predicate must be explicit");
      const slot = frame.slots.find(row => row.id === "object")!;
      return [{ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: query },
        source_endpoint: { kind: "frame", frame: source }, query_support: { kind: "query_text", excerpt },
        source_semantic_support: [{ kind: "lexical", mentions: predicate.mentions }] },
      { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: query, slot: "object" },
        source_endpoint: { kind: "slot", frame: source, slot: "object" }, query_support: { kind: "query_text", excerpt: "consignment" },
        source_semantic_support: slot.support }];
    });
  const result = receiveAuthoredCorrespondence({ original_query: ORIGINAL_QUERY, admitted_query_semantics: QUERY,
    source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: h }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences });
  if (result.semantic_correspondence === undefined) throw new Error(`authored C admission failed: ${JSON.stringify(result.outcome)}`);
  return result.semantic_correspondence;
}

export function sourceActions(fixture: Fixture, source: ManifestSource): Action[] {
  return (["dispatch", "examine"] as const).map((frame, index) => {
    const quote = `${frame === "dispatch" ? "Dispatch" : "Inspection"} records are under ${fixture.hints[index]}.`;
    const start = source.source_body.indexOf(quote);
    if (start < 0) throw new Error("action quote must be in the actually observed initial source");
    return { frame, alternative: 0, obligation: "context", access_hint: fixture.hints[index]!, support: {
      source_id: source.source_id, source_version: source.source_version, content_digest: source.content_digest,
      quote, utf8_span: [Buffer.byteLength(source.source_body.slice(0, start)), Buffer.byteLength(source.source_body.slice(0, start + quote.length))] } };
  });
}

export type Decision = { status: "covered_reported_pair" | "reported_but_ineligible" | "feedback_omitted"
  | "feedback_truncated" | "no_unique_action"; reason: string; selected: Action | null };
/** Only an exact eligible pair in actual public attention may control an action. */
export function selectAction(result: SourceSemanticReasoningResult | undefined, descriptor: Descriptor,
  c: SourceSemanticCorrespondence, candidates: readonly Action[]): Decision {
  const stop = (status: Decision["status"], reason: string): Decision => ({ status, reason, selected: null });
  const attention = result?.attention;
  if (attention === undefined) return stop("feedback_omitted", "public reason did not report attention");
  if (attention.kind !== "computed") return stop("reported_but_ineligible", "preparation is not computed feedback");
  if (attention.truncated) return stop("feedback_truncated", "bounded feedback omitted entries");
  const expected = { conditional_computation_id: result!.conditional_computation_id,
    source_interpretation_id: descriptor.interpretation_id, query_semantics_id: sourceSemanticQueryIdentity(QUERY, fieldContractSha256),
    semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(c, fieldContractSha256),
    source_id: descriptor.source_id, source_version: descriptor.source_version, content_digest: descriptor.content_digest };
  if (Object.entries(expected).some(([key, value]) => value === undefined || attention[key as keyof typeof attention] !== value)
    || result!.source_interpretation_id !== expected.source_interpretation_id
    || result!.query_semantics_id !== expected.query_semantics_id || result!.semantic_correspondence_id !== expected.semantic_correspondence_id) {
    return stop("reported_but_ineligible", "feedback identity does not match the current H/Q/C/source computation");
  }
  const eligible = attention.entries.filter(entry => entry.alternative === 0 && entry.obligation === "context"
    && entry.state === "observed_no_match" && entry.observation === "exhausted" && entry.scope?.kind === "pair");
  if (eligible.length === 0) return stop("reported_but_ineligible", "no exhausted no-match context pair was reported");
  const matches = candidates.filter(candidate => candidate.alternative === 0 && candidate.obligation === "context"
    && candidate.support.source_id === descriptor.source_id && candidate.support.source_version === descriptor.source_version
    && candidate.support.content_digest === descriptor.content_digest
    && eligible.some(entry => entry.frame === candidate.frame));
  if (matches.length !== 1) return stop("no_unique_action", `eligible pairs match ${matches.length} action candidates`);
  return { status: "covered_reported_pair", reason: "one source-bound action covers the reported context pair", selected: matches[0]! };
}

export function initialObservations(receipts: readonly (SourceSemanticAccessReceipt | undefined)[]) {
  const rows = receipts.filter((row): row is SourceSemanticAccessReceipt => row !== undefined);
  const first = rows[0], identities = new Set(rows.flatMap(row => row.source_candidates.map(source => source.record_id)));
  const consistent = first !== undefined && rows.every(row => row.pool_id === first.pool_id
    && row.observed_source_count === first.observed_source_count) && identities.size <= first.observed_source_count;
  const reads = new Map(rows.flatMap(row => row.source_candidates.filter(source => source.read_bytes > 0).map(source => [source.record_id, source] as const)));
  return { status: consistent ? "consistent" : "missing_or_inconsistent", complete: consistent && identities.size === first!.observed_source_count,
    missing_identity_count: consistent ? first!.observed_source_count - identities.size : null,
    explicit_record_ids: [...identities], read_sources: [...reads.values()],
    receipt_extents: rows.map(row => ({ pool_id: row.pool_id, observed_source_count: row.observed_source_count, trace: row.trace })) };
}

export function selectFinalDescriptor(candidates: readonly Descriptor[], initialInterpretationId: string) {
  const eligible = candidates.filter(row => row.interpretation_id !== initialInterpretationId
    && row.interpretation?.frames.some(frame => frame.id === "send" || frame.id === "inspect"));
  return eligible.find(row => row.interpretation!.frames.some(frame => frame.id === "send")
    && row.interpretation!.frames.some(frame => frame.id === "inspect")) ?? eligible[0];
}

/** Declared source assertions are independent of H, C, Field and access outputs. */
export function finiteReference(fixture: Fixture) {
  const initial = fixture.name === "inspection-known" ? [["inspect", "J9"]] : [["send", fixture.name === "split-item" ? "K4" : "J9"]];
  const dispatch = fixture.name === "inspection-known" ? [["send", "J9"], ["inspect", "J9"]]
    : [["send", fixture.name === "split-item" ? "K4" : "J9"]];
  const examine = fixture.name === "inspection-known" ? [["inspect", "J9"]]
    : [["send", fixture.name === "split-item" ? "K4" : "J9"], ["inspect", fixture.name === "split-item" ? "K5" : "J9"]];
  const options = [{ hint: fixture.hints[0], text: fixture.dispatch, events: dispatch },
    { hint: fixture.hints[1], text: fixture.examine, events: examine }];
  const sets = [[], [options[0]!], [options[1]!], options].map(selected => {
    const events = [...initial, ...selected.flatMap(row => row.events)];
    const items = [...new Set(events.filter(([verb]) => verb === "send").map(([, item]) => item!))]
      .filter(item => events.some(([verb, other]) => verb === "inspect" && other === item));
    const sourceBodies = [...new Set([fixture.initial, ...selected.map(row => row.text)])];
    return { hints: selected.map(row => row.hint), asserted_events: events, same_item_assignments: items,
      source_string_array_json_bytes: Buffer.byteLength(JSON.stringify(sourceBodies)), source_bodies: sourceBodies };
  });
  return { sets, no_field_orders: [fixture.hints, [...fixture.hints].reverse()], union_execution: "hindsight_only",
    byte_encoding: "UTF-8 JSON array of deduplicated exact source strings; not native response bytes" };
}

export function expectedBindings(fixture: Fixture, h: SourceSemanticInterpretation) {
  return fixture.expected_positive !== null && h.source.source_id === `${fixture.name}/${fixture.expected_positive}`
    ? [{ item: "itemJ9", sentEvent: "send", inspectedEvent: "inspect" }] : [];
}

export function allowanceLedger(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return { ...(db.prepare("SELECT work_reserved, memory_reserved, read_count, effect_count FROM cycle").get() as
      { work_reserved: number; memory_reserved: number; read_count: number; effect_count: number }),
    actions: db.prepare("SELECT name, work_units, memory_bytes FROM effects ORDER BY rowid").all(),
    reads: db.prepare("SELECT ordinal, label, input_bytes FROM read_observations ORDER BY ordinal").all(),
    actual_native: db.prepare("SELECT name, work_json FROM native_observations ORDER BY rowid").all()
      .map(row => ({ name: row.name, work: JSON.parse(String(row.work_json)) })) };
  } finally { db.close(); }
}
