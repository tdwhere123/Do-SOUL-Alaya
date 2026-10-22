import { z } from "zod";
import { admitInputFormation, INPUT_NAVIGATION_POLICY, type FormationAdmissionState } from "../source-access-diagnostic/input-condition-formation.js";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import type { ProviderRequestAttemptClass } from "../provider-request/execution.js";
import type { EvidenceSelectionIdentity, EvidenceSelectionLine, EvidenceSelectionSource } from "./input.js";
import type { EvidenceSelectionReferenceFormat, EvidenceSelectionReferences } from "./source-references.js";

export const EVIDENCE_SELECTION_MAX_SELECTED = 5;

const ModelOutputSchema = z.object({
  status: z.enum(["proposal", "cannot_propose"]),
  selected: z.array(z.object({
    root_id: z.string().min(1),
    quotes: z.array(z.string().min(1)).min(1).max(3),
    contribution: z.string().min(1)
  }).strict()).max(EVIDENCE_SELECTION_MAX_SELECTED),
  unresolved: z.array(z.string().min(1))
}).strict();

const ReferenceSelectionSchema = z.object({
  sourceRef: z.string().min(1),
  contribution: ModelOutputSchema.shape.selected.element.shape.contribution
}).strict();
const ReferenceUnresolvedSchema = z.array(z.string().refine((value) => value.trim().length > 0));
const ReferenceLiteralOutputSchema = ModelOutputSchema.extend({
  unresolved: ReferenceUnresolvedSchema,
  selected: z.array(ReferenceSelectionSchema.extend({
    quotes: ModelOutputSchema.shape.selected.element.shape.quotes
  })).max(EVIDENCE_SELECTION_MAX_SELECTED)
});
const ReferenceWitnessOutputSchema = ModelOutputSchema.extend({
  unresolved: ReferenceUnresolvedSchema,
  selected: z.array(ReferenceSelectionSchema.extend({
    witnessRefs: ModelOutputSchema.shape.selected.element.shape.quotes
  })).max(EVIDENCE_SELECTION_MAX_SELECTED)
});

export type EvidenceSelectionFailureReason =
  | "malformed_json"
  | "unknown_root"
  | "duplicate_root"
  | "quote_mismatch"
  | "invalid_shape"
  | "abstain_has_selection"
  | "abstain_missing_unresolved"
  | "proposal_missing_unresolved"
  | "unknown_source_ref"
  | "unknown_witness_ref"
  | "witness_owner_mismatch"
  | "duplicate_witness_ref"
  | "noncomplete";

export type EvidenceSelectionBoundEntry = Readonly<{
  root_id: string;
  quotes: readonly string[];
  identity: EvidenceSelectionIdentity;
}>;

export type EvidenceSelectionOutcome = { readonly formation_state?: FormationAdmissionState } & (
  | {
      readonly status: "interpreted";
      readonly selected: readonly EvidenceSelectionBoundEntry[];
      readonly unresolved: readonly string[];
    }
  | { readonly status: "abstained"; readonly unresolved: readonly string[] }
  | { readonly status: "invalid"; readonly reason: EvidenceSelectionFailureReason }
  | { readonly status: "incomplete"; readonly reason: "noncomplete" }
  | { readonly status: "transport_failure"; readonly failure?: unknown });

export function evidenceSelectionResponseJsonSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "selected", "unresolved"],
    properties: {
      status: { type: "string", enum: ["proposal", "cannot_propose"] },
      selected: {
        type: "array",
        maxItems: EVIDENCE_SELECTION_MAX_SELECTED,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["root_id", "quotes", "contribution"],
          properties: {
            root_id: { type: "string", minLength: 1 },
            quotes: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: { type: "string", minLength: 1 }
            },
            contribution: { type: "string", minLength: 1 }
          }
        }
      },
      unresolved: { type: "array", items: { type: "string", minLength: 1 } }
    }
  };
}

export function evidenceSelectionReferenceResponseJsonSchema(format: EvidenceSelectionReferenceFormat): object {
  const schema = evidenceSelectionResponseJsonSchema() as {
    properties: { selected: { items: { required: string[]; properties: Record<string, unknown> } } };
  };
  const entry = schema.properties.selected.items;
  const { root_id, quotes, contribution } = entry.properties;
  const support = format === "literal" ? "quotes" : "witnessRefs";
  entry.required = ["sourceRef", support, "contribution"];
  entry.properties = { sourceRef: root_id, [support]: quotes, contribution };
  return schema;
}

export function interpretEvidenceSelectionDecoded(
  line: EvidenceSelectionLine,
  decoded: Readonly<{ rawJson: string; finishReason: string | null }>,
  requestProfile: string
): {
  classified: ProviderRequestAttemptClass;
  admitted: boolean;
  outcome: EvidenceSelectionOutcome;
} {
  if (!isCompleteSemanticFinish(requestProfile, decoded.finishReason)) {
    return { classified: "incomplete", admitted: false, outcome: { status: "incomplete", reason: "noncomplete" } };
  }
  if (line.inputNavigation !== undefined) {
    const formation = admitInputFormation({ task: INPUT_NAVIGATION_POLICY, input: line.inputNavigation,
      state: "complete", raw_json: decoded.rawJson, provenance: line.key, reason: null }, line.inputNavigation);
    if (formation.available) return { classified: "interpreted", admitted: true,
      outcome: { status: "interpreted", selected: [], unresolved: formation.unresolved, formation_state: formation.state } };
    return formation.state === "rejected" || formation.state === "malformed"
      ? { classified: "terminal", admitted: false, outcome: { status: "invalid",
        reason: formation.state === "malformed" ? "malformed_json" : "invalid_shape", formation_state: formation.state } }
      : { classified: "abstained", admitted: false, outcome: { status: "abstained",
        unresolved: formation.unresolved, formation_state: formation.state } };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(decoded.rawJson); }
  catch {
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: "malformed_json" } };
  }
  const normalized = normalizeReferenceOutput(line, parsed);
  if (!normalized.ok) {
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: normalized.reason } };
  }
  const model = ModelOutputSchema.safeParse(normalized.value);
  if (!model.success) {
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: "invalid_shape" } };
  }
  if (model.data.status === "cannot_propose") {
    if (model.data.selected.length > 0) {
      return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: "abstain_has_selection" } };
    }
    if (model.data.unresolved.length === 0) {
      return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: "abstain_missing_unresolved" } };
    }
    return {
      classified: "abstained",
      admitted: false,
      outcome: { status: "abstained", unresolved: model.data.unresolved }
    };
  }
  if (line.referenceOutput !== undefined && model.data.selected.length === 0 && model.data.unresolved.length === 0) {
    return { classified: "terminal", admitted: false,
      outcome: { status: "invalid", reason: "proposal_missing_unresolved" } };
  }
  const bound = bindSelectedQuotes(line.sources, model.data.selected);
  if (bound.ok === false) {
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: bound.reason } };
  }
  return {
    classified: "interpreted",
    admitted: true,
    outcome: { status: "interpreted", selected: bound.selected, unresolved: model.data.unresolved }
  };
}

/** Resolve only the frozen request locators, then let the native literal binder decide admission. */
function normalizeReferenceOutput(line: EvidenceSelectionLine, value: unknown):
  { ok: true; value: unknown } | { ok: false; reason: EvidenceSelectionFailureReason } {
  const reference = line.referenceOutput;
  if (reference === undefined) return { ok: true, value };
  const model = (reference.format === "literal" ? ReferenceLiteralOutputSchema : ReferenceWitnessOutputSchema).safeParse(value);
  if (!model.success) return { ok: false, reason: "invalid_shape" };
  const sources = new Map(reference.references.sources.map((source) => [source.sourceRef, source.root_id]));
  const witnesses = new Map(reference.references.witnesses.map((witness) => [witness.witnessRef, witness]));
  const seenWitnesses = new Set<string>();
  const selected = [];
  for (const entry of model.data.selected) {
    const root_id = sources.get(entry.sourceRef);
    if (root_id === undefined) return { ok: false, reason: "unknown_source_ref" };
    const resolved = "quotes" in entry ? { ok: true as const, quotes: entry.quotes }
      : resolveWitnessQuotes(entry.sourceRef, entry.witnessRefs, witnesses, seenWitnesses);
    if (!resolved.ok) return resolved;
    selected.push({ root_id, quotes: resolved.quotes, contribution: entry.contribution });
  }
  return { ok: true, value: { ...model.data, selected } };
}

function resolveWitnessQuotes(sourceRef: string, refs: readonly string[],
  witnesses: ReadonlyMap<string, EvidenceSelectionReferences["witnesses"][number]>, seen: Set<string>):
  { ok: true; quotes: string[] } | { ok: false; reason: EvidenceSelectionFailureReason } {
  const quotes: string[] = [];
  for (const ref of refs) {
    const witness = witnesses.get(ref);
    if (witness === undefined) return { ok: false, reason: "unknown_witness_ref" };
    if (witness.sourceRef !== sourceRef) return { ok: false, reason: "witness_owner_mismatch" };
    if (seen.has(ref)) return { ok: false, reason: "duplicate_witness_ref" };
    seen.add(ref);
    quotes.push(witness.quote);
  }
  return { ok: true, quotes };
}

function bindSelectedQuotes(
  sources: readonly EvidenceSelectionSource[],
  selected: readonly { root_id: string; quotes: readonly string[] }[]
): { ok: true; selected: EvidenceSelectionBoundEntry[] } | { ok: false; reason: EvidenceSelectionFailureReason } {
  const byRoot = new Map<string, EvidenceSelectionSource>();
  for (const source of sources) {
    if (byRoot.has(source.root_id)) {
      return { ok: false, reason: "duplicate_root" };
    }
    byRoot.set(source.root_id, source);
  }
  const seen = new Set<string>();
  const bound: EvidenceSelectionBoundEntry[] = [];
  for (const entry of selected) {
    if (seen.has(entry.root_id)) return { ok: false, reason: "duplicate_root" };
    seen.add(entry.root_id);
    const source = byRoot.get(entry.root_id);
    if (source === undefined) return { ok: false, reason: "unknown_root" };
    for (const quote of entry.quotes) {
      if (!source.preview.includes(quote)) return { ok: false, reason: "quote_mismatch" };
    }
    bound.push({
      root_id: entry.root_id,
      quotes: entry.quotes,
      identity: {
        root_id: source.root_id,
        version: source.version,
        digest: source.digest,
        span: source.span
      }
    });
  }
  return { ok: true, selected: bound };
}
