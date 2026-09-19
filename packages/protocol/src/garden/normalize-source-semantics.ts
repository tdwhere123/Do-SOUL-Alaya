import { z } from "zod";
import { sourceSemanticStanceLists } from "./source-semantic-structure.js";
export { sourceSemanticStanceLists } from "./source-semantic-structure.js";
import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted } from "./source-semantic-resources.js";
import { AlayaError } from "../shared/alaya-error.js";
import { canonicalSourceSemanticDecimal } from "./source-semantic-quantified-validation.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import {
  SourceReferenceCatalogSchema, sourceReferencePreparationCost, sourceReferenceResolver,
  type SourceReferenceCatalog
} from "../evidence/source-reference.js";
import {
  SOURCE_SEMANTIC_PACKET_CONTRACT, SourceSemanticDraftSchema,
  type SourceSemanticDraft, type SourceSemanticMention
} from "./source-semantic-draft.js";
import {
  SourceSemanticInterpretationSchema, SourceSemanticSourceBindingSchema,
  type SourceSemanticInterpretation, type SourceSemanticNormalizedMention,
  type SourceSemanticSourceBinding
} from "./source-semantic-interpretation.js";

export const SOURCE_SEMANTIC_K_VERSION = "source-semantic-k-v3" as const;
export const SOURCE_SEMANTIC_NORMALIZER_VERSION = "source-semantic-normalizer-v3" as const;

export type SourceSemanticNormalizationBudget = Readonly<{
  readonly work_units: number;
  readonly memory_bytes: number;
}>;

export type SourceSemanticNormalizationInput = Readonly<{
  readonly draft: unknown;
  readonly catalog: SourceReferenceCatalog;
  readonly sha256: FieldContractSha256;
  readonly source: SourceSemanticSourceBinding;
  readonly producer_id: string;
  readonly producer_version: string;
  readonly contract_version: string;
  readonly budget?: SourceSemanticNormalizationBudget;
  readonly meter?: SourceSemanticResourceLedger;
}>;

export type SourceSemanticHandleMap = Readonly<Record<string, string>>;

export type SourceSemanticNormalizationResult =
  | {
      readonly status: "normalized";
      readonly interpretation: SourceSemanticInterpretation;
      readonly alpha_map: SourceSemanticHandleMap;
    }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "resource_exhausted" };

type Ok<T> = { readonly status: "ok"; readonly value: T };

export function normalizeSourceSemantics(
  input: SourceSemanticNormalizationInput
): SourceSemanticNormalizationResult {
  const gated = gateResources(input);
  if (gated !== undefined) return gated;
  const draft = parseDraft(input.draft);
  if (draft.status !== "ok") return draft;
  const mentions = resolveMentions(draft.value.mentions, input.catalog, input.sha256);
  if (mentions.status !== "ok") return mentions;
  return assemble(draft.value, mentions.value, input);
}

function gateResources(
  input: SourceSemanticNormalizationInput
): SourceSemanticNormalizationResult | undefined {
  try {
    const meter = input.meter ?? new SourceSemanticResourceLedger(input.budget ?? { work_units: 200000, memory_bytes: 20000000 });
    meter.retain(input.draft, "normalization input");
    meter.retain(input.catalog, "normalization catalog");
    const catalog = SourceReferenceCatalogSchema.parse(input.catalog);
    const cost = sourceReferencePreparationCost(catalog.assertions.map((row) => ({
      assertion_id: row.assertion_id,
      text: row.segments.map((segment) => segment.text).join("")
    })));
    meter.charge(cost.work_units, cost.memory_bytes, "reference normalization");
    return undefined;
  } catch (error) {
    return fromCaught(error);
  }
}

function parseDraft(value: unknown): Ok<SourceSemanticDraft> | SourceSemanticNormalizationResult {
  const parsed = SourceSemanticDraftSchema.safeParse(value);
  return parsed.success ? { status: "ok", value: parsed.data } : fromIssues(parsed.error.issues);
}

function resolveMentions(
  mentions: readonly SourceSemanticMention[],
  catalog: SourceReferenceCatalog,
  sha256: FieldContractSha256
): Ok<readonly SourceSemanticNormalizedMention[]> | SourceSemanticNormalizationResult {
  try {
    const resolver = sourceReferenceResolver(catalog, sha256);
    return {
      status: "ok",
      value: mentions.map((mention) => {
        const located = resolver.resolve(catalog.catalog_id, mention.assertion_id, mention.source_ref);
        return {
          id: mention.id,
          assertion_id: mention.assertion_id,
          source_ref: mention.source_ref,
          text: located.text,
          // The unit tag prevents a durable span being converted a second time.
          span_space: "assertion_code_units" as const,
          utf8_span: located.span
        };
      })
    };
  } catch (error) {
    return fromCaught(error);
  }
}

function assemble(
  draft: SourceSemanticDraft,
  mentions: readonly SourceSemanticNormalizedMention[],
  input: SourceSemanticNormalizationInput
): SourceSemanticNormalizationResult {
  const source = SourceSemanticSourceBindingSchema.safeParse(input.source);
  if (!source.success) return fromIssues(source.error.issues);
  const occurrences = [...draft.frames, ...draft.operators];
  const parsed = SourceSemanticInterpretationSchema.safeParse({
    contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: source.data,
    producer_id: input.producer_id,
    producer_version: input.producer_version,
    contract_version: input.contract_version,
    mentions,
    referents: draft.referents,
    frames: draft.frames,
    operators: draft.operators,
    ...(draft.domains === undefined ? {} : { domains: draft.domains }),
    ...(draft.measurements === undefined ? {} : { measurements: draft.measurements.map((row) => ({
      ...row, value: canonicalSourceSemanticDecimal(row.value)
    })) }),
    gaps: draft.gaps,
    ...sourceSemanticStanceLists(occurrences)
  });
  if (!parsed.success) return fromIssues(parsed.error.issues);
  return {
    status: "normalized",
    interpretation: parsed.data,
    alpha_map: Object.freeze(identityMap(draft))
  };
}

function identityMap(draft: SourceSemanticDraft): Record<string, string> {
  const ids = [
    ...draft.mentions.map((row) => row.id),
    ...draft.referents.map((row) => row.id),
    ...draft.frames.map((row) => row.id),
    ...draft.operators.map((row) => row.id),
    ...(draft.domains ?? []).map((row) => row.id),
    ...(draft.measurements ?? []).map((row) => row.id)
  ];
  return Object.fromEntries(ids.map((id) => [id, id]));
}

function fromCaught(error: unknown): SourceSemanticNormalizationResult {
  if (error instanceof SourceSemanticResourceExhausted) return { status: "resource_exhausted" };
  if (error instanceof AlayaError) return fromIssues([{ message: error.message }]);
  if (error instanceof z.ZodError) return fromIssues(error.issues);
  throw error;
}

function fromIssues(issues: readonly { message: string }[]): SourceSemanticNormalizationResult {
  const messages = issues.map((issue) => issue.message);
  if (messages.some(isResourceMessage)) return { status: "resource_exhausted" };
  return { status: "invalid", reason: messages[0] ?? "invalid source semantics" };
}

function isResourceMessage(message: string): boolean {
  return message === "source semantic graph exceeds its byte bound"
    || message.includes("exceeds its assertion/text bound")
    || message.includes("exceeds its segment bound");
}
