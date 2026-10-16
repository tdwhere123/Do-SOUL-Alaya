import {
  canonicalJson, type RequestBudget, type SourceSemanticAccessPolicy, type SourceSemanticAccessSignal,
  type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticResourceLedger,
  type SourceSemanticPreviewExtents
} from "@do-soul/alaya-protocol";
import { scoreQueryEvidenceContent } from "../../embedding-recall/evidence/query-evidence-scoring.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { CoreError } from "../../shared/errors.js";
import { compileRecallQueryProbes, type RecallQueryProbes } from "../query/recall-query-probes.js";

const UNKNOWN_SIGNAL: SourceSemanticAccessSignal = { source_text_score: null, interpretation_reading_score: 0 };
const SOURCE_SEMANTIC_ACCESS_RESOURCE_CONTRACT = "empty-interpretation-reserve-v1";

function sourceSemanticAccessOrderCost(count: number): Readonly<{ work_units: number; memory_bytes: number }> {
  return { work_units: count * Math.ceil(Math.log2(count + 1)), memory_bytes: count * 16 };
}

export function sourceSemanticAccessInputIdentity(input: Readonly<{
  original_query: string; query_semantics?: SourceSemanticQuery; source_id?: string; access_hint?: string;
  budget: RequestBudget; policy: SourceSemanticAccessPolicy; source_preview_extents?: SourceSemanticPreviewExtents;
  contract?: "source-semantic-access-v2";
}>): string {
  return `sha256:${fieldContractSha256(canonicalJson({ original_query: input.original_query,
    query_semantics: input.query_semantics, source_id: input.source_id, budget: input.budget, policy: input.policy,
    ...(input.access_hint === undefined ? {} : { access_hint: input.access_hint }),
    ...(input.source_preview_extents === undefined ? {} : { source_preview_extents: input.source_preview_extents }),
    resource_contract: input.contract === "source-semantic-access-v2" ? "shared-union-completion-reserve-v2" :
      SOURCE_SEMANTIC_ACCESS_RESOURCE_CONTRACT }))}`;
}

export function authorizeSemanticScope(scope: string | null | undefined, authorized: readonly string[] | null): void {
  if (scope == null) throw new CoreError("VALIDATION", "source has no governed scope", { details: { admission: "filtered" } });
  if (authorized !== null && !authorized.includes(scope)) {
    throw new CoreError("VALIDATION", "source is outside authorized scopes", { details: { admission: "filtered" } });
  }
}

/** One local access policy for raw sources and verified interpretations. It does not establish correspondence. */
export function createSourceSemanticAccessPolicy(original: string, query: SourceSemanticQuery | undefined,
  policy: SourceSemanticAccessPolicy, meter: SourceSemanticResourceLedger, accessHint?: string) {
  if (accessHint !== undefined && policy === "canonical-v1") {
    throw new CoreError("VALIDATION", "canonical access cannot use an access hint");
  }
  const chargeQueryFeatures = (text: string, ledger: SourceSemanticResourceLedger): void =>
    ledger.charge(64 * (text.length + 1), 128 * (text.length + 1), "access query features");
  const compile = (text: string): Readonly<RecallQueryProbes> => {
    chargeQueryFeatures(text, meter);
    return compileRecallQueryProbes(text);
  };
  const originalProbes = compile(original);
  const readings = (query?.alternatives ?? []).flatMap((alternative, index) => alternative.frames
    .filter((frame) => frame.operator === undefined)
    .map((frame) => ({ alternative: index, frame: frame.id, probes: compile(frame.predicate_reading) })));
  const cost = (length: number, probes: Readonly<RecallQueryProbes>) => ({
    work_units: (length + 1) * (4 + Math.min(32, probes.lexical_terms.length) + Math.min(12, probes.phrases.length)),
    memory_bytes: 16 * (length + 1)
  });
  const score = (text: string, probes: Readonly<RecallQueryProbes>, ledger: SourceSemanticResourceLedger): number => {
    const needed = cost(text.length, probes);
    ledger.charge(needed.work_units, needed.memory_bytes, "access text normalization and scoring");
    return scoreQueryEvidenceContent(text, probes);
  };
  type Scored = { readonly identity: string; readonly signal: SourceSemanticAccessSignal };
  const compare = (aIdentity: string, aSignal: SourceSemanticAccessSignal,
    bIdentity: string, bSignal: SourceSemanticAccessSignal): number => {
    if (policy === "query-conditioned-v1") {
      const raw = (bSignal.source_text_score ?? 0) - (aSignal.source_text_score ?? 0);
      if (raw !== 0) return raw;
      const reading = bSignal.interpretation_reading_score - aSignal.interpretation_reading_score;
      if (reading !== 0) return reading;
    }
    return aIdentity < bIdentity ? -1 : aIdentity > bIdentity ? 1 : 0;
  };
  const order = <T>(rows: readonly T[], ledger: SourceSemanticResourceLedger, compareRows: (a: T, b: T) => number): T[] => {
    const cost = sourceSemanticAccessOrderCost(rows.length);
    ledger.charge(cost.work_units, cost.memory_bytes, "access ordering");
    return [...rows].sort(compareRows);
  };
  const sourceHints = new Map<string, SourceSemanticAccessSignal>();
  return {
    orderCost: sourceSemanticAccessOrderCost,
    navigationQuery: (ledger: SourceSemanticResourceLedger): string | null => {
      if (policy === "canonical-v1") return null;
      const navigation = accessHint ?? original;
      chargeQueryFeatures(navigation, ledger);
      return navigation;
    },
    sourceCost: (length: number) => cost(length, originalProbes),
    source: (text: string, ledger: SourceSemanticResourceLedger): SourceSemanticAccessSignal => ({
      source_text_score: score(text, originalProbes, ledger), interpretation_reading_score: 0
    }),
    interpretation: (source: SourceSemanticAccessSignal, interpretation: SourceSemanticInterpretation,
      ledger: SourceSemanticResourceLedger): SourceSemanticAccessSignal => {
      let best: SourceSemanticAccessSignal = { source_text_score: source.source_text_score, interpretation_reading_score: 0 };
      // Compare individual predicate readings; do not flatten unrelated frames or score graph metadata.
      for (const queryReading of readings) for (const frame of interpretation.frames) {
        const value = score(frame.predicate_support.reading, queryReading.probes, ledger);
        if (value > best.interpretation_reading_score) best = {
          source_text_score: source.source_text_score, interpretation_reading_score: value,
          reading: { query_alternative: queryReading.alternative, query_frame: queryReading.frame, source_frame: frame.id }
        };
      }
      return best;
    },
    order: <T extends Scored>(rows: readonly T[], ledger: SourceSemanticResourceLedger): T[] =>
      order(rows, ledger, (a, b) => compare(a.identity, a.signal, b.identity, b.signal)),
    associateSourceHint: (digest: string, signal: SourceSemanticAccessSignal, ledger: SourceSemanticResourceLedger): void => {
      if (policy === "canonical-v1") return;
      ledger.charge(1, digest.length * 2 + 48, "access source hint association");
      const prior = sourceHints.get(digest);
      if (prior === undefined || compare("", signal, "", prior) < 0) sourceHints.set(digest, signal);
    },
    schedule: <T extends { readonly identity: string; readonly source_hash: string | null; readonly query_hint?: true }>(rows: readonly T[],
      exploration: readonly T[], ledger: SourceSemanticResourceLedger): T[] => {
      ledger.charge(rows.length, rows.length * 8, "access verification schedule");
      if (policy === "canonical-v1") return [...rows];
      // Headers are already retained by observation; ordering only copies their references.
      const priority = order(rows, ledger, (a, b) => Number(b.query_hint === true) - Number(a.query_hint === true)
        || compare(a.identity, sourceHints.get(a.source_hash ?? "") ?? UNKNOWN_SIGNAL,
          b.identity, sourceHints.get(b.source_hash ?? "") ?? UNKNOWN_SIGNAL));
      const seen = new Set<string>(), scheduled: T[] = [];
      const takeNext = (queue: readonly T[], offset: number): number => {
        while (offset < queue.length) {
          const row = queue[offset++]!;
          ledger.charge(1, 16, "access schedule deduplication");
          if (seen.has(row.identity)) continue;
          seen.add(row.identity); scheduled.push(row); break;
        }
        return offset;
      };
      // A lexical nominee may also occupy its independently observed cursor position.
      // Advance past duplicates before alternating so a shared identity cannot waste a turn.
      let priorityOffset = 0, cursorOffset = 0;
      while (priorityOffset < priority.length || cursorOffset < exploration.length) {
        priorityOffset = takeNext(priority, priorityOffset);
        cursorOffset = takeNext(exploration, cursorOffset);
      }
      return scheduled;
    }
  };
}
