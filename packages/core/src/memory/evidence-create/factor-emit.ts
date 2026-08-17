import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  hashFactorId,
  hashIncidenceId,
  normalizeMemoryObjectKeySurface,
  verifyFactorDescriptor,
  verifyFactorIncidence,
  type AddressableSourceSpan,
  type FactorDescriptor,
  type FactorFamily,
  type FactorIncidence,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";
import { tokenizeWithSpans } from "../object-keys/normalize/tokenize.js";
import { sliceUtf8Span } from "./source-span-views.js";

export interface FactorEmitInput {
  readonly sha256: FieldContractSha256;
  readonly recorded_at: string;
  readonly workspace_id: string;
  readonly scope: string;
  readonly source_id: string;
  readonly source_version: string;
  readonly content_bytes: string;
  readonly actor: string | null;
  readonly event_time: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly spans: readonly AddressableSourceSpan[];
  readonly factFrameSlots: readonly Readonly<{ readonly text: string }>[];
  readonly semanticSurfaces: readonly string[];
}

export interface EmittedFactorFormation {
  readonly factors: readonly FactorDescriptor[];
  readonly incidences: readonly FactorIncidence[];
}

export function emitDeterministicIncidences(
  input: FactorEmitInput
): EmittedFactorFormation {
  const factors = new Map<string, FactorDescriptor>();
  const incidences: FactorIncidence[] = [];
  for (const span of input.spans) {
    emitExactSurface(input, span, factors, incidences);
    emitNormalizedTokens(input, span, factors, incidences);
  }
  const host = input.spans[0];
  if (host !== undefined) {
    emitViewFactors(input, host, factors, incidences);
    emitContextFactors(input, host, factors, incidences);
  }
  return Object.freeze({
    factors: Object.freeze([...factors.values()]),
    incidences: Object.freeze(incidences)
  });
}

function emitExactSurface(
  input: FactorEmitInput,
  span: AddressableSourceSpan,
  factors: Map<string, FactorDescriptor>,
  incidences: FactorIncidence[]
): void {
  const surface = sliceUtf8Span(input.content_bytes, span);
  addIncidence(input, span, "f0", surface, factors, incidences);
  addIncidence(input, span, "f0", `source_id:${input.source_id}`, factors, incidences);
  addIncidence(
    input,
    span,
    "f0",
    `source_version:${input.source_version}`,
    factors,
    incidences
  );
}

function emitNormalizedTokens(
  input: FactorEmitInput,
  span: AddressableSourceSpan,
  factors: Map<string, FactorDescriptor>,
  incidences: FactorIncidence[]
): void {
  const surface = sliceUtf8Span(input.content_bytes, span);
  for (const token of tokenizeWithSpans(surface)) {
    addIncidence(input, span, "f1", token.token, factors, incidences);
  }
}

function emitViewFactors(
  input: FactorEmitInput,
  span: AddressableSourceSpan,
  factors: Map<string, FactorDescriptor>,
  incidences: FactorIncidence[]
): void {
  for (const slot of input.factFrameSlots) {
    addIncidence(input, span, "f1", slot.text, factors, incidences);
  }
  for (const surface of input.semanticSurfaces) {
    addIncidence(input, span, "f3", surface, factors, incidences);
  }
}

function emitContextFactors(
  input: FactorEmitInput,
  span: AddressableSourceSpan,
  factors: Map<string, FactorDescriptor>,
  incidences: FactorIncidence[]
): void {
  addIncidence(input, span, "f2", `scope:${input.scope}`, factors, incidences);
  addIncidence(input, span, "f2", `source:${input.source_id}`, factors, incidences);
  if (input.actor !== null) {
    addIncidence(input, span, "f2", `actor:${input.actor}`, factors, incidences);
  }
  addGroundedTime(input, span, "event_time", input.event_time, factors, incidences);
  addGroundedTime(input, span, "valid_from", input.valid_from, factors, incidences);
  addGroundedTime(input, span, "valid_to", input.valid_to, factors, incidences);
}

function addGroundedTime(
  input: FactorEmitInput,
  span: AddressableSourceSpan,
  label: string,
  value: string | null,
  factors: Map<string, FactorDescriptor>,
  incidences: FactorIncidence[]
): void {
  if (value === null) return;
  addIncidence(input, span, "f2", `${label}:${value}`, factors, incidences);
}

function addIncidence(
  input: FactorEmitInput,
  span: AddressableSourceSpan,
  family: FactorFamily,
  rawPayload: string,
  factors: Map<string, FactorDescriptor>,
  incidences: FactorIncidence[]
): void {
  const canonical = family === "f0" ? rawPayload : normalizeMemoryObjectKeySurface(rawPayload);
  if (canonical.length === 0) return;
  const factor = descriptor(input, family, canonical);
  factors.set(factor.identity, factor);
  incidences.push(incidence(input, span.identity, factor.identity));
}

function descriptor(
  input: FactorEmitInput,
  family: FactorFamily,
  canonicalPayload: string
): FactorDescriptor {
  const operatorId = FACTOR_INCIDENCE_OPERATOR_ID;
  const identity = hashFactorId({
    family,
    canonical_payload: canonicalPayload,
    operator_id: operatorId
  }, input.sha256);
  return verifyFactorDescriptor({
    schema_version: 1,
    producer: operatorId,
    consumer: "projection_generation",
    identity,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    workspace_id: input.workspace_id,
    family,
    canonical_payload: canonicalPayload,
    operator_id: operatorId,
    recorded_at: input.recorded_at
  }, input.sha256);
}

function incidence(
  input: FactorEmitInput,
  spanId: string,
  factorId: string
): FactorIncidence {
  const operatorId = FACTOR_INCIDENCE_OPERATOR_ID;
  const identity = hashIncidenceId({
    span_id: spanId,
    factor_id: factorId,
    scope: input.scope,
    operator_id: operatorId
  }, input.sha256);
  return verifyFactorIncidence({
    schema_version: 1,
    producer: operatorId,
    consumer: "projection_generation",
    identity,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    workspace_id: input.workspace_id,
    span_id: spanId,
    factor_id: factorId,
    scope: input.scope,
    operator_id: operatorId,
    recorded_at: input.recorded_at
  }, input.sha256);
}
