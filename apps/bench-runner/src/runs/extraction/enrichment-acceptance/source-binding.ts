import { findSourceTextOccurrence } from "@do-soul/alaya-protocol";
import {
  buildOfficialApiSourceCorpus,
  type OfficialApiSemanticWorkUnit,
  type TransportPack
} from "@do-soul/alaya-soul";
import type { FrozenAssertion } from "./frozen-population.js";

export type FrozenBindingStatus = "bound" | "unbound" | "ineligible" | "ambiguous";

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
  }[];
  readonly source_corpus_identity?: string;
  readonly sourceCorpus?: string;
  readonly sourceTurn?: {
    readonly turnContent: string;
    readonly turnMessages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
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

export interface FrozenAssertionBinding {
  readonly row: FrozenAssertion;
  readonly status: FrozenBindingStatus;
  readonly reason: string;
  readonly current: FrozenBoundCurrentSource | null;
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
  const needle = stripLeadingRoleMarker(row.exact_text);
  const units = selectCatalogUnits(row, input.catalogUnits);
  if (units.length > 1) {
    return freezeBinding(row, "ambiguous", "catalog text matches more than one current unit", null);
  }
  if (units.length === 1) {
    const unit = units[0]!;
    return freezeBinding(row, "bound", "current occurrence or unique catalog text matches one unit", Object.freeze({
      assertion_id: unit.assertionId,
      semanticKey: unit.semanticKey,
      sourceCorpusIdentity: unit.binding.sourceCorpusIdentity,
      locator: Object.freeze({
        start: unit.binding.locator.start,
        end: unit.binding.locator.end
      }),
      occurrenceIdentity: unit.binding.occurrenceIdentity ?? null,
      request_keys: requestKeysForUnit(unit, input.requests)
    }));
  }
  const corpora = collectSourceCorpora(input);
  if (corpora === null) {
    return freezeBinding(
      row,
      "unbound",
      "exact text absent from current catalog; source corpus unavailable so eligibility is unknown",
      null
    );
  }
  const present = corpora.some((corpus) => findSourceTextOccurrence(corpus, needle, 0) !== null);
  if (present) {
    return freezeBinding(
      row,
      "ineligible",
      "exact text is present in the current source corpus but filtered from the current catalog",
      null
    );
  }
  return freezeBinding(row, "unbound", "exact text absent from the current source corpus", null);
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

function selectCatalogUnits(
  row: FrozenAssertion,
  units: FrozenSourceBindingInput["catalogUnits"]
): FrozenCatalogUnit[] {
  const catalogs = units.map(asCatalogUnit);
  const identities = frozenOccurrenceIdentities(row);
  if (identities.size > 0) {
    const hits = catalogs.filter((unit) => {
      const identity = unit.binding.occurrenceIdentity;
      return identity !== undefined && identities.has(identity);
    });
    if (hits.length > 0) return hits;
  }
  const needle = stripLeadingRoleMarker(row.exact_text);
  let candidates = catalogs.filter((unit) => stripLeadingRoleMarker(unit.text) === needle);
  const corpora = frozenCorpusIdentities(row);
  if (corpora.size > 0) {
    const restricted = candidates.filter((unit) => corpora.has(unit.binding.sourceCorpusIdentity));
    if (restricted.length > 0) candidates = restricted;
  }
  const locators = frozenLocators(row);
  if (locators.length > 0 && candidates.length > 1) {
    const restricted = candidates.filter((unit) => locators.some((locator) =>
      locator.start === unit.binding.locator.start && locator.end === unit.binding.locator.end));
    if (restricted.length > 0) candidates = restricted;
  }
  return candidates;
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

function frozenOccurrenceIdentities(row: FrozenAssertion): ReadonlySet<string> {
  const identities = new Set<string>();
  if (row.occurrence.source_occurrence_identity !== null) {
    identities.add(row.occurrence.source_occurrence_identity);
  }
  for (const binding of row.occurrence.occurrence_bindings) {
    if (!isRecord(binding)) continue;
    const identity = binding.occurrenceIdentity;
    if (typeof identity === "string" && identity.length > 0) identities.add(identity);
  }
  return identities;
}

function frozenCorpusIdentities(row: FrozenAssertion): ReadonlySet<string> {
  const corpora = new Set<string>();
  for (const binding of row.occurrence.occurrence_bindings) {
    if (!isRecord(binding)) continue;
    const identity = binding.sourceCorpusIdentity;
    if (typeof identity === "string" && identity.length > 0) corpora.add(identity);
  }
  return corpora;
}

function frozenLocators(row: FrozenAssertion): readonly { readonly start: number; readonly end: number }[] {
  const locators: { start: number; end: number }[] = [];
  pushLocator(locators, row.occurrence.source_locator);
  for (const binding of row.occurrence.occurrence_bindings) {
    if (!isRecord(binding)) continue;
    pushLocator(locators, binding.locator);
  }
  return locators;
}

function pushLocator(
  locators: { start: number; end: number }[],
  value: unknown
): void {
  if (!isRecord(value)) return;
  if (typeof value.start !== "number" || typeof value.end !== "number") return;
  locators.push({ start: value.start, end: value.end });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestKeysForUnit(
  unit: FrozenCatalogUnit,
  requests: FrozenSourceBindingInput["requests"]
): readonly string[] | null {
  if (requests === undefined) return null;
  const needle = stripLeadingRoleMarker(unit.text);
  return Object.freeze(requests.filter((request) => {
    if (request.source_corpus_identity !== undefined &&
        request.source_corpus_identity !== unit.binding.sourceCorpusIdentity) {
      return false;
    }
    return request.source_assertions.some((assertion) =>
      stripLeadingRoleMarker(assertion.text) === needle);
  }).map((request) => request.key));
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
      : Object.freeze(input.requests.map((request) => request.source_assertions.length)),
    unit_count: input.catalogUnits.length
  });
}

function freezeBinding(
  row: FrozenAssertion,
  status: FrozenBindingStatus,
  reason: string,
  current: FrozenBoundCurrentSource | null
): FrozenAssertionBinding {
  return Object.freeze({ row, status, reason, current });
}
