import { findSourceTextOccurrence } from "@do-soul/alaya-protocol";
import {
  buildOfficialApiSourceCorpus,
  type OfficialApiSemanticWorkUnit,
  type TransportPack
} from "@do-soul/alaya-soul";
import type { FrozenAssertion } from "./frozen-population.js";

export type FrozenBindingStatus =
  | "bound"
  | "unbound"
  | "ineligible"
  | "ambiguous"
  | "partial";

export type FrozenOccurrenceStatus =
  | "bound"
  | "unbound"
  | "ineligible"
  | "ambiguous"
  | "lost";

export interface FrozenCatalogUnit {
  readonly assertionId: number;
  readonly text: string;
  readonly semanticKey: string;
  readonly binding: {
    readonly sourceCorpusIdentity: string;
    readonly occurrenceIdentity?: string;
    readonly locator: {
      readonly start: number;
      readonly end: number;
    };
  };
  readonly sourceCorpus?: string;
}

export interface FrozenBindingRequest {
  readonly key: string;
  readonly source_assertions: readonly {
    readonly assertion_id: number;
    readonly text: string;
    readonly occurrenceIdentity?: string;
    readonly source_message_id?: string | null;
  }[];
  readonly source_corpus_identity?: string;
  readonly message_ids?: readonly string[];
  readonly sourceCorpus?: string;
  readonly sourceTurn?: {
    readonly turnContent: string;
    readonly turnMessages: readonly {
      readonly message_id?: string;
      readonly role: "user" | "assistant";
      readonly content: string;
    }[];
  };
}

export interface FrozenSourceBindingInput {
  readonly sourceCorpus?: string;
  readonly catalogUnits: readonly FrozenCatalogUnit[] | readonly OfficialApiSemanticWorkUnit[];
  readonly requests?: readonly FrozenBindingRequest[];
  readonly packs?: readonly TransportPack[];
}

export interface FrozenBoundCurrentSource {
  readonly assertion_id: number;
  readonly semanticKey: string;
  readonly sourceCorpusIdentity: string;
  readonly locator: {
    readonly start: number;
    readonly end: number;
  };
  readonly occurrenceIdentity: string | null;
  readonly request_keys: readonly string[] | null;
}

export interface FrozenOccurrenceRestriction {
  readonly occurrenceIdentity: string | null;
  readonly sourceCorpusIdentity: string | null;
  readonly locator: {
    readonly start: number;
    readonly end: number;
  } | null;
  readonly source_message_id: string | null;
}

export interface FrozenOccurrenceBinding {
  readonly frozen: FrozenOccurrenceRestriction;
  readonly status: FrozenOccurrenceStatus;
  readonly reason: string;
  readonly current: FrozenBoundCurrentSource | null;
}

export interface FrozenAssertionBinding {
  readonly row: FrozenAssertion;
  readonly status: FrozenBindingStatus;
  readonly reason: string;
  readonly occurrences: readonly FrozenOccurrenceBinding[];
  readonly current: readonly FrozenBoundCurrentSource[];
}

export interface FrozenPackingCardinalities {
  readonly request_count: number | null;
  readonly pack_count: number | null;
  readonly pack_cardinalities: readonly number[] | null;
  readonly request_assertion_cardinalities: readonly number[] | null;
  readonly unit_count: number;
}

export interface FrozenPopulationBindings {
  readonly bindings: readonly FrozenAssertionBinding[];
  readonly packing: FrozenPackingCardinalities;
}

export function bindFrozenAssertionToCurrentSource(
  row: FrozenAssertion,
  input: FrozenSourceBindingInput
): FrozenAssertionBinding {
  const catalogs = input.catalogUnits.map(asCatalogUnit);
  const specs = frozenOccurrenceSpecs(row);
  if (specs.length === 0) {
    return freezeBinding(row, [bindUnrestrictedOccurrence(row, catalogs, input)]);
  }
  return freezeBinding(row, bindRestrictedOccurrences(row, specs, catalogs, input));
}

export function bindFrozenPopulation(
  rows: readonly FrozenAssertion[],
  input: FrozenSourceBindingInput
): FrozenPopulationBindings {
  return Object.freeze({
    bindings: Object.freeze(rows.map((row) => bindFrozenAssertionToCurrentSource(row, input))),
    packing: packingCardinalities(input)
  });
}

function stripLeadingRoleMarker(text: string): string {
  return text.replace(/^(?:User|Assistant): /u, "");
}

function bindRestrictedOccurrences(
  row: FrozenAssertion,
  specs: readonly FrozenOccurrenceRestriction[],
  catalogs: readonly FrozenCatalogUnit[],
  input: FrozenSourceBindingInput
): readonly FrozenOccurrenceBinding[] {
  const claimed = new Set<string>();
  const slots: Array<FrozenOccurrenceBinding | null> = specs.map(() => null);
  for (const [index, spec] of specs.entries()) {
    const hits = selectRestrictedUnits(row, spec, catalogs).filter((unit) =>
      !claimed.has(unitKey(unit)) && (spec.occurrenceIdentity !== null ||
        spec.source_message_id === null || unitPackedInFrozenMessage(unit, spec.source_message_id, input)));
    if (hits.length === 1) {
      claimed.add(unitKey(hits[0]!));
      slots[index] = occurrenceBinding(
        spec, "bound", "frozen occurrence matches one current unit",
        boundCurrent(hits[0]!, input.requests)
      );
    } else if (hits.length > 1) {
      slots[index] = occurrenceBinding(
        spec, "ambiguous", "frozen occurrence matches more than one current unit", null
      );
    }
  }
  for (const [index, spec] of specs.entries()) {
    if (slots[index] !== null) continue;
    const available = catalogs.filter((unit) => !claimed.has(unitKey(unit)));
    const hits = migrateRestrictedUnits(row, spec, available, input);
    const corpora = new Set(hits.map((unit) => unit.binding.sourceCorpusIdentity));
    if (corpora.size > 1) {
      markRemainingAmbiguous(
        slots, specs, "frozen occurrence matches current units in more than one source corpus"
      );
      break;
    }
    if (hits.length === 0) {
      slots[index] = occurrenceBinding(
        spec, "lost",
        "frozen occurrence restriction has zero current hits; global same-text fallback is not used",
        null
      );
      continue;
    }
    const peers = countPeerUnassigned(row, hits, specs, slots, available, input);
    if (hits.length === peers && !hitsOverlapOtherUnassigned(row, hits, specs, slots, available, input)) {
      claimed.add(unitKey(hits[0]!));
      slots[index] = occurrenceBinding(
        spec, "bound", "frozen occurrence migrated through native source identity",
        boundCurrent(hits[0]!, input.requests)
      );
      continue;
    }
    markPeerAmbiguous(
      row, hits, specs, slots, available, input,
      "frozen occurrence matches more than one current unit"
    );
  }
  return Object.freeze(slots.map((item, index) => item ?? occurrenceBinding(
    specs[index]!, "lost", "frozen occurrence restriction has zero current hits; global same-text fallback is not used", null
  )));
}

function markRemainingAmbiguous(
  slots: Array<FrozenOccurrenceBinding | null>,
  specs: readonly FrozenOccurrenceRestriction[],
  reason: string
): void {
  for (const [index, spec] of specs.entries()) {
    if (slots[index] !== null) continue;
    slots[index] = occurrenceBinding(spec, "ambiguous", reason, null);
  }
}

function countPeerUnassigned(
  row: FrozenAssertion,
  hits: readonly FrozenCatalogUnit[],
  specs: readonly FrozenOccurrenceRestriction[],
  slots: ReadonlyArray<FrozenOccurrenceBinding | null>,
  available: readonly FrozenCatalogUnit[],
  input: FrozenSourceBindingInput
): number {
  let peers = 0;
  for (const [index, spec] of specs.entries()) {
    if (slots[index] !== null) continue;
    const otherHits = migrateRestrictedUnits(row, spec, available, input);
    if (sameHitKeys(hits, otherHits)) peers += 1;
  }
  return peers;
}

function markPeerAmbiguous(
  row: FrozenAssertion,
  hits: readonly FrozenCatalogUnit[],
  specs: readonly FrozenOccurrenceRestriction[],
  slots: Array<FrozenOccurrenceBinding | null>,
  available: readonly FrozenCatalogUnit[],
  input: FrozenSourceBindingInput,
  reason: string
): void {
  for (const [index, spec] of specs.entries()) {
    if (slots[index] !== null) continue;
    const otherHits = migrateRestrictedUnits(row, spec, available, input);
    if (sameHitKeys(hits, otherHits)) {
      slots[index] = occurrenceBinding(spec, "ambiguous", reason, null);
    }
  }
}

function hitsOverlapOtherUnassigned(
  row: FrozenAssertion,
  hits: readonly FrozenCatalogUnit[],
  specs: readonly FrozenOccurrenceRestriction[],
  slots: ReadonlyArray<FrozenOccurrenceBinding | null>,
  available: readonly FrozenCatalogUnit[],
  input: FrozenSourceBindingInput
): boolean {
  const keys = new Set(hits.map(unitKey));
  for (const [index, spec] of specs.entries()) {
    if (slots[index] !== null) continue;
    const otherHits = migrateRestrictedUnits(row, spec, available, input);
    if (sameHitKeys(hits, otherHits)) continue;
    if (otherHits.some((unit) => keys.has(unitKey(unit)))) return true;
  }
  return false;
}

function sameHitKeys(
  left: readonly FrozenCatalogUnit[],
  right: readonly FrozenCatalogUnit[]
): boolean {
  if (left.length !== right.length) return false;
  const keys = new Set(left.map(unitKey));
  return right.every((unit) => keys.has(unitKey(unit)));
}

function unitKey(unit: FrozenCatalogUnit): string {
  return [
    unit.binding.occurrenceIdentity ?? "",
    unit.binding.sourceCorpusIdentity,
    String(unit.binding.locator.start),
    String(unit.binding.locator.end),
    unit.semanticKey
  ].join("\u0000");
}

function bindUnrestrictedOccurrence(
  row: FrozenAssertion,
  catalogs: readonly FrozenCatalogUnit[],
  input: FrozenSourceBindingInput
): FrozenOccurrenceBinding {
  const spec = emptyRestriction();
  const needle = stripLeadingRoleMarker(row.exact_text);
  const hits = catalogs.filter((unit) => stripLeadingRoleMarker(unit.text) === needle);
  if (hits.length > 1) {
    return occurrenceBinding(spec, "ambiguous", "catalog text matches more than one current unit", null);
  }
  if (hits.length === 1) {
    return occurrenceBinding(
      spec,
      "bound",
      "current occurrence or unique catalog text matches one unit",
      boundCurrent(hits[0]!, input.requests)
    );
  }
  const corpora = collectSourceCorpora(input);
  if (corpora === null) {
    return occurrenceBinding(
      spec,
      "unbound",
      "exact text absent from current catalog; source corpus unavailable so eligibility is unknown",
      null
    );
  }
  const present = corpora.some((corpus) => findSourceTextOccurrence(corpus, needle, 0) !== null);
  if (present) {
    return occurrenceBinding(
      spec,
      "ineligible",
      "exact text is present in the current source corpus but filtered from the current catalog",
      null
    );
  }
  return occurrenceBinding(spec, "unbound", "exact text absent from the current source corpus", null);
}

function selectRestrictedUnits(
  row: FrozenAssertion,
  spec: FrozenOccurrenceRestriction,
  catalogs: readonly FrozenCatalogUnit[]
): FrozenCatalogUnit[] {
  const needle = stripLeadingRoleMarker(row.exact_text);
  return catalogs.filter((unit) => unitMatchesRestriction(unit, spec, needle));
}

function migrateRestrictedUnits(
  row: FrozenAssertion,
  spec: FrozenOccurrenceRestriction,
  catalogs: readonly FrozenCatalogUnit[],
  input: FrozenSourceBindingInput
): FrozenCatalogUnit[] {
  const needle = stripLeadingRoleMarker(row.exact_text);
  let hits = catalogs.filter((unit) => stripLeadingRoleMarker(unit.text) === needle);
  if (spec.locator !== null) {
    hits = hits.filter((unit) =>
      unit.binding.locator.start === spec.locator!.start &&
      unit.binding.locator.end === spec.locator!.end);
  }
  // Same corpus identity is not message provenance. Migration needs the native
  // containing-message witness for this precise packed occurrence.
  if (spec.sourceCorpusIdentity !== null) {
    const corpusHits = hits.filter((unit) =>
      unit.binding.sourceCorpusIdentity === spec.sourceCorpusIdentity);
    if (corpusHits.length > 0) {
      if (spec.source_message_id === null) return [];
      const messageId = spec.source_message_id;
      return corpusHits.filter((unit) =>
        unitPackedInFrozenMessage(unit, messageId, input));
    }
  }
  if (spec.source_message_id === null) return [];
  const messageId = spec.source_message_id;
  const local = corporaForMessage(messageId, input);
  if (local === null) return [];
  return hits.filter((unit) =>
    local.has(unit.binding.sourceCorpusIdentity) &&
    unitPackedInFrozenMessage(unit, messageId, input));
}

function corporaForMessage(
  messageId: string,
  input: FrozenSourceBindingInput
): ReadonlySet<string> | null {
  if (input.requests === undefined) return null;
  const corpora = new Set<string>();
  for (const request of input.requests) {
    if (!requestHasMessage(request, messageId)) continue;
    if (request.source_corpus_identity !== undefined) corpora.add(request.source_corpus_identity);
  }
  return corpora;
}

function requestHasMessage(request: FrozenBindingRequest, messageId: string): boolean {
  if (request.source_assertions.some((assertion) => assertion.source_message_id === messageId)) return true;
  if (request.message_ids?.includes(messageId) === true) return true;
  return request.sourceTurn?.turnMessages.some((message) => message.message_id === messageId) === true;
}

function unitPackedInFrozenMessage(
  unit: FrozenCatalogUnit,
  messageId: string,
  input: FrozenSourceBindingInput
): boolean {
  const occurrenceIdentity = unit.binding.occurrenceIdentity;
  if (occurrenceIdentity === undefined || occurrenceIdentity.length === 0) return false;
  return (input.requests ?? []).some((request) =>
    request.source_corpus_identity === unit.binding.sourceCorpusIdentity &&
    request.source_assertions.some((assertion) =>
      assertion.assertion_id === unit.assertionId &&
      assertion.occurrenceIdentity === occurrenceIdentity &&
      assertion.source_message_id === messageId));
}

function unitMatchesRestriction(
  unit: FrozenCatalogUnit,
  spec: FrozenOccurrenceRestriction,
  needle: string
): boolean {
  if (spec.occurrenceIdentity !== null) {
    if (unit.binding.occurrenceIdentity !== spec.occurrenceIdentity) return false;
  } else if (stripLeadingRoleMarker(unit.text) !== needle) {
    return false;
  }
  if (spec.sourceCorpusIdentity !== null &&
      unit.binding.sourceCorpusIdentity !== spec.sourceCorpusIdentity) {
    return false;
  }
  // Historical locator contract versions may differ from the live catalog.
  // Occurrence identity is the rebind key; locator is strict only when identity is absent.
  if (spec.occurrenceIdentity === null && spec.locator !== null) {
    if (unit.binding.locator.start !== spec.locator.start ||
        unit.binding.locator.end !== spec.locator.end) {
      return false;
    }
  }
  return true;
}

function asCatalogUnit(unit: FrozenCatalogUnit | OfficialApiSemanticWorkUnit): FrozenCatalogUnit {
  return {
    assertionId: unit.assertionId,
    text: unit.text,
    semanticKey: unit.semanticKey,
    binding: {
      sourceCorpusIdentity: unit.binding.sourceCorpusIdentity,
      ...(unit.binding.occurrenceIdentity === undefined
        ? {}
        : { occurrenceIdentity: unit.binding.occurrenceIdentity }),
      locator: {
        start: unit.binding.locator.start,
        end: unit.binding.locator.end
      }
    },
    sourceCorpus: unit.sourceCorpus
  };
}

function frozenOccurrenceSpecs(row: FrozenAssertion): readonly FrozenOccurrenceRestriction[] {
  const fromBindings: FrozenOccurrenceRestriction[] = [];
  for (const binding of row.occurrence.occurrence_bindings) {
    const spec = restrictionFromBinding(binding, row);
    if (spec !== null) fromBindings.push(spec);
  }
  if (fromBindings.length > 0) return Object.freeze(fromBindings);
  const identity = row.occurrence.source_occurrence_identity;
  const locator = readLocator(row.occurrence.source_locator);
  if (identity === null && locator === null) return Object.freeze([]);
  return Object.freeze([{
    occurrenceIdentity: identity,
    sourceCorpusIdentity: null,
    locator,
    source_message_id: row.occurrence.source_message_ids[0] ?? null
  }]);
}

function restrictionFromBinding(
  value: unknown,
  row: FrozenAssertion
): FrozenOccurrenceRestriction | null {
  if (!isRecord(value)) return null;
  const spec: FrozenOccurrenceRestriction = {
    occurrenceIdentity: readOptionalString(value.occurrenceIdentity),
    sourceCorpusIdentity: readOptionalString(value.sourceCorpusIdentity),
    locator: readLocator(value.locator),
    source_message_id: readOptionalString(value.source_message_id) ??
      (row.occurrence.source_message_ids[0] ?? null)
  };
  if (spec.occurrenceIdentity === null &&
      spec.sourceCorpusIdentity === null &&
      spec.locator === null) {
    return null;
  }
  return spec;
}

function readLocator(value: unknown): FrozenOccurrenceRestriction["locator"] {
  if (!isRecord(value)) return null;
  if (typeof value.start !== "number" || typeof value.end !== "number") return null;
  return { start: value.start, end: value.end };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestKeysForUnit(
  unit: FrozenCatalogUnit,
  requests: FrozenSourceBindingInput["requests"]
): readonly string[] | null {
  if (requests === undefined) return null;
  return Object.freeze(requests.filter((request) => requestIncludesUnit(request, unit)).map((request) => request.key));
}

function requestIncludesUnit(request: FrozenBindingRequest, unit: FrozenCatalogUnit): boolean {
  if (request.source_corpus_identity !== undefined &&
      request.source_corpus_identity !== unit.binding.sourceCorpusIdentity) {
    return false;
  }
  return request.source_assertions.some((assertion) => assertion.assertion_id === unit.assertionId &&
    (assertion.occurrenceIdentity === undefined ||
      assertion.occurrenceIdentity === unit.binding.occurrenceIdentity));
}

function collectSourceCorpora(input: FrozenSourceBindingInput): readonly string[] | null {
  const corpora: string[] = [];
  if (input.sourceCorpus !== undefined) corpora.push(input.sourceCorpus);
  for (const unit of input.catalogUnits) {
    if (unit.sourceCorpus !== undefined) corpora.push(unit.sourceCorpus);
  }
  if (input.requests !== undefined) {
    for (const request of input.requests) {
      if (request.sourceCorpus !== undefined) corpora.push(request.sourceCorpus);
      if (request.sourceTurn !== undefined) {
        corpora.push(buildOfficialApiSourceCorpus(
          request.sourceTurn.turnContent,
          request.sourceTurn.turnMessages
        ));
      }
    }
  }
  if (corpora.length === 0) return null;
  return Object.freeze([...new Set(corpora)]);
}

function packingCardinalities(input: FrozenSourceBindingInput): FrozenPackingCardinalities {
  return Object.freeze({
    request_count: input.requests === undefined ? null : input.requests.length,
    pack_count: input.packs === undefined ? null : input.packs.length,
    pack_cardinalities: input.packs === undefined
      ? null
      : Object.freeze(input.packs.map((pack) => pack.assertion_ids.length)),
    request_assertion_cardinalities: input.requests === undefined
      ? null
      : Object.freeze(input.requests.map((request) =>
        new Set(request.source_assertions.map((assertion) => assertion.assertion_id)).size)),
    unit_count: input.catalogUnits.length
  });
}

function boundCurrent(
  unit: FrozenCatalogUnit,
  requests: FrozenSourceBindingInput["requests"]
): FrozenBoundCurrentSource {
  return Object.freeze({
    assertion_id: unit.assertionId,
    semanticKey: unit.semanticKey,
    sourceCorpusIdentity: unit.binding.sourceCorpusIdentity,
    locator: Object.freeze({
      start: unit.binding.locator.start,
      end: unit.binding.locator.end
    }),
    occurrenceIdentity: unit.binding.occurrenceIdentity ?? null,
    request_keys: requestKeysForUnit(unit, requests)
  });
}

function emptyRestriction(): FrozenOccurrenceRestriction {
  return Object.freeze({
    occurrenceIdentity: null,
    sourceCorpusIdentity: null,
    locator: null,
    source_message_id: null
  });
}

function occurrenceBinding(
  frozen: FrozenOccurrenceRestriction,
  status: FrozenOccurrenceStatus,
  reason: string,
  current: FrozenBoundCurrentSource | null
): FrozenOccurrenceBinding {
  return Object.freeze({ frozen, status, reason, current });
}

function freezeBinding(
  row: FrozenAssertion,
  occurrences: readonly FrozenOccurrenceBinding[]
): FrozenAssertionBinding {
  const aggregated = aggregateAssertionStatus(occurrences);
  const wiped = aggregated.status === "ambiguous";
  const published = wiped
    ? occurrences.map((item) => item.current === null
      ? item
      : occurrenceBinding(item.frozen, item.status, item.reason, null))
    : occurrences;
  const current = Object.freeze(
    wiped ? [] : published.flatMap((item) => item.current === null ? [] : [item.current])
  );
  return Object.freeze({
    row,
    status: aggregated.status,
    reason: aggregated.reason,
    occurrences: Object.freeze([...published]),
    current
  });
}

function aggregateAssertionStatus(
  occurrences: readonly FrozenOccurrenceBinding[]
): { readonly status: FrozenBindingStatus; readonly reason: string } {
  const bound = occurrences.filter((item) => item.status === "bound");
  const ambiguous = occurrences.filter((item) => item.status === "ambiguous");
  const missing = occurrences.filter((item) => (
    item.status === "lost" || item.status === "unbound" || item.status === "ineligible"
  ));
  if (ambiguous.length > 0) {
    return { status: "ambiguous", reason: ambiguous[0]!.reason };
  }
  if (bound.length === occurrences.length && bound.length > 0) {
    return {
      status: "bound",
      reason: bound.length === 1
        ? bound[0]!.reason
        : "all frozen occurrences match current units"
    };
  }
  if (bound.length > 0 && missing.length > 0) {
    return {
      status: "partial",
      reason: `${bound.length} of ${occurrences.length} frozen occurrences bound; missing occurrences are reported`
    };
  }
  if (occurrences.every((item) => item.status === "ineligible")) {
    return { status: "ineligible", reason: occurrences[0]!.reason };
  }
  const lost = occurrences.find((item) => item.status === "lost");
  if (lost !== undefined) {
    return { status: "unbound", reason: lost.reason };
  }
  return {
    status: "unbound",
    reason: occurrences[0]?.reason ?? "exact text absent from the current source corpus"
  };
}
