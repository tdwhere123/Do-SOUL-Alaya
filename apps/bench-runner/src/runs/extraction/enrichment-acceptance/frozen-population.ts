import { readFileSync } from "node:fs";
import { basename } from "node:path";

export const FROZEN_ENRICHMENT_POPULATION_TOTAL = 38;
export const FROZEN_ENRICHMENT_REQUIRED_COUNT = 15;
export const FROZEN_ENRICHMENT_OPTIONAL_COUNT = 21;
export const FROZEN_ENRICHMENT_UNRESOLVED_COUNT = 2;

const FIRST_STAGE_ASSERTION_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const ASPIRATION_REGRESSION_IDS = new Set([2, 6]);
const REGRESSION_DUPLICATE_OF: Readonly<Record<number, number>> = Object.freeze({ 6: 2 });

export type FrozenPopulationKind = "regression" | "canonical";
export type FrozenClassification = "required" | "optional" | "unresolved";

export interface FrozenAnnotationPointer {
  readonly file: string;
  readonly assertion_id: number;
  readonly request_key: string;
  readonly canonical_index: number | null;
}

export interface FrozenOriginalSource {
  readonly exact_text: string;
  readonly utf8_start?: number;
  readonly utf8_end?: number;
  readonly normalization?: string;
}

export interface FrozenOccurrencePointers {
  readonly source_message_ids: readonly string[];
  readonly source_locator: unknown;
  readonly source_occurrence_identity: string | null;
  readonly occurrence_bindings: readonly unknown[];
}

export interface FrozenAssertion {
  readonly population: FrozenPopulationKind;
  readonly annotation_pointer: FrozenAnnotationPointer;
  readonly original_ordinal: number;
  readonly exact_text: string;
  readonly original_source: FrozenOriginalSource;
  readonly occurrence: FrozenOccurrencePointers;
  readonly classification: FrozenClassification;
  readonly required_group_id: string | null;
  readonly first_stage_subset: boolean;
  readonly obligations: readonly string[];
  readonly forbidden: readonly string[];
  readonly duplicate_of: number | null;
}

export interface FrozenEnrichmentPopulation {
  readonly rows: readonly FrozenAssertion[];
  readonly counts: {
    readonly total: number;
    readonly required: number;
    readonly optional: number;
    readonly unresolved: number;
  };
}

export class FrozenPopulationCountError extends Error {
  readonly name = "FrozenPopulationCountError";
  readonly actual: FrozenEnrichmentPopulation["counts"];
  readonly expected: FrozenEnrichmentPopulation["counts"];

  constructor(actual: FrozenEnrichmentPopulation["counts"]) {
    const expected = Object.freeze({
      total: FROZEN_ENRICHMENT_POPULATION_TOTAL,
      required: FROZEN_ENRICHMENT_REQUIRED_COUNT,
      optional: FROZEN_ENRICHMENT_OPTIONAL_COUNT,
      unresolved: FROZEN_ENRICHMENT_UNRESOLVED_COUNT
    });
    super(
      `frozen enrichment population counts ${actual.total}/${actual.required}/${actual.optional}/${actual.unresolved} do not match ${expected.total}/${expected.required}/${expected.optional}/${expected.unresolved}`
    );
    this.actual = Object.freeze({ ...actual });
    this.expected = expected;
  }
}

export function loadFrozenEnrichmentPopulation(input: {
  readonly regressionPath: string;
  readonly canonicalPath: string;
}): FrozenEnrichmentPopulation {
  const regression = readJsonObject(input.regressionPath);
  const canonical = readJsonObject(input.canonicalPath);
  const regressionRows = readRegressionRows(input.regressionPath, regression);
  const canonicalRows = readCanonicalRows(input.canonicalPath, canonical);
  const rows = Object.freeze([...regressionRows, ...canonicalRows]);
  const counts = countClassifications(rows);
  if (
    counts.total !== FROZEN_ENRICHMENT_POPULATION_TOTAL ||
    counts.required !== FROZEN_ENRICHMENT_REQUIRED_COUNT ||
    counts.optional !== FROZEN_ENRICHMENT_OPTIONAL_COUNT ||
    counts.unresolved !== FROZEN_ENRICHMENT_UNRESOLVED_COUNT
  ) {
    throw new FrozenPopulationCountError(counts);
  }
  return Object.freeze({ rows, counts });
}

function readRegressionRows(filePath: string, document: Record<string, unknown>): readonly FrozenAssertion[] {
  const assertions = document.assertions;
  if (!Array.isArray(assertions) || assertions.length !== 16) {
    throw new TypeError("regression annotations must contain 16 assertions");
  }
  const file = basename(filePath);
  return Object.freeze(assertions.map((entry) => {
    const record = asRecord(entry, "regression assertion");
    const assertionId = readPositiveInt(record.assertion_id, "regression assertion_id");
    const classification = mapFrozenClassification(record.classification);
    return freezeAssertion({
      population: "regression",
      annotation_pointer: Object.freeze({
        file,
        assertion_id: assertionId,
        request_key: readString(record.key, "regression key"),
        canonical_index: null
      }),
      original_ordinal: assertionId,
      exact_text: readString(record.exact_text, "regression exact_text"),
      original_source: readOriginalSource(record.original_source, readString(record.exact_text, "regression exact_text")),
      occurrence: Object.freeze({
        source_message_ids: Object.freeze([
          readString(record.source_message_id, "regression source_message_id")
        ]),
        source_locator: record.source_locator ?? null,
        source_occurrence_identity: readOptionalString(record.source_occurrence_identity),
        occurrence_bindings: Object.freeze([])
      }),
      classification,
      required_group_id: regressionRequiredGroupId(assertionId, classification),
      first_stage_subset: FIRST_STAGE_ASSERTION_IDS.has(assertionId),
      obligations: readStringArray(record.obligations, "regression obligations"),
      forbidden: readStringArray(record.prohibited_inferences, "regression prohibited_inferences"),
      duplicate_of: REGRESSION_DUPLICATE_OF[assertionId] ?? null
    });
  }));
}

function readCanonicalRows(filePath: string, document: Record<string, unknown>): readonly FrozenAssertion[] {
  const requests = document.requests;
  if (!Array.isArray(requests) || requests.length !== 16) {
    throw new TypeError("canonical annotations must contain 16 requests");
  }
  const file = basename(filePath);
  const rows: FrozenAssertion[] = [];
  for (const requestValue of requests) {
    const request = asRecord(requestValue, "canonical request");
    const canonicalIndex = readPositiveInt(request.canonical_index, "canonical_index");
    const requestKey = readString(request.key, "canonical key");
    const reviews = request.assertion_reviews;
    if (!Array.isArray(reviews)) {
      throw new TypeError("canonical request is missing assertion_reviews");
    }
    for (const reviewValue of reviews) {
      const review = asRecord(reviewValue, "canonical assertion review");
      const assertionId = readPositiveInt(review.assertion_id, "canonical assertion_id");
      const classification = mapFrozenClassification(review.classification);
      const exactText = readString(review.exact_text, "canonical exact_text");
      rows.push(freezeAssertion({
        population: "canonical",
        annotation_pointer: Object.freeze({
          file,
          assertion_id: assertionId,
          request_key: readString(review.key ?? requestKey, "canonical review key"),
          canonical_index: canonicalIndex
        }),
        original_ordinal: assertionId,
        exact_text: exactText,
        original_source: readOriginalSource(review.original_source, exactText),
        occurrence: Object.freeze({
          source_message_ids: readStringArray(review.source_message_ids, "canonical source_message_ids"),
          source_locator: null,
          source_occurrence_identity: firstOccurrenceIdentity(review.occurrence_bindings),
          occurrence_bindings: Object.freeze(Array.isArray(review.occurrence_bindings)
            ? [...review.occurrence_bindings]
            : [])
        }),
        classification,
        required_group_id: classification === "required"
          ? `canonical:${canonicalIndex}:${assertionId}`
          : null,
        first_stage_subset: false,
        obligations: readStringArray(review.coverage, "canonical coverage"),
        forbidden: readStringArray(review.forbidden, "canonical forbidden"),
        duplicate_of: null
      }));
    }
  }
  return Object.freeze(rows);
}

function regressionRequiredGroupId(
  assertionId: number,
  classification: FrozenClassification
): string | null {
  if (ASPIRATION_REGRESSION_IDS.has(assertionId)) return "aspiration";
  if (assertionId === 4) return "capability";
  if (assertionId === 8) return "release";
  if (classification === "required") return `regression:${assertionId}`;
  return null;
}

function mapFrozenClassification(value: unknown): FrozenClassification {
  if (value === "in_scope_durable_proposition") return "required";
  if (value === "legitimate_abstention_candidate") return "optional";
  if (value === "unsupported_unresolved_interpretation") return "unresolved";
  throw new TypeError(`unrecognized frozen classification: ${String(value)}`);
}

function countClassifications(rows: readonly FrozenAssertion[]): FrozenEnrichmentPopulation["counts"] {
  let required = 0;
  let optional = 0;
  let unresolved = 0;
  for (const row of rows) {
    if (row.classification === "required") required += 1;
    else if (row.classification === "optional") optional += 1;
    else unresolved += 1;
  }
  return Object.freeze({ total: rows.length, required, optional, unresolved });
}

function freezeAssertion(row: FrozenAssertion): FrozenAssertion {
  return Object.freeze(row);
}

function readOriginalSource(value: unknown, fallbackText: string): FrozenOriginalSource {
  if (!isRecord(value) || typeof value.exact_text !== "string") {
    return Object.freeze({ exact_text: fallbackText });
  }
  return Object.freeze({
    exact_text: value.exact_text,
    ...(typeof value.utf8_start === "number" ? { utf8_start: value.utf8_start } : {}),
    ...(typeof value.utf8_end === "number" ? { utf8_end: value.utf8_end } : {}),
    ...(typeof value.normalization === "string" ? { normalization: value.normalization } : {})
  });
}

function firstOccurrenceIdentity(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || !isRecord(value[0])) return null;
  return readOptionalString(value[0].occurrenceIdentity);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return asRecord(parsed, filePath);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function readStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be a string array`);
  }
  return Object.freeze([...value]);
}
