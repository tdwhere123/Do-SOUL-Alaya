import { type SourceSemanticAccessPolicy, type SourceSemanticAccessSignal,
  type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { scoreQueryEvidenceContent } from "../../embedding-recall/evidence/query-evidence-scoring.js";
import { compileRecallQueryProbes, type RecallQueryProbes } from "../query/recall-query-probes.js";
import { CoreError } from "../../shared/errors.js";

const UNKNOWN_SIGNAL: SourceSemanticAccessSignal = { source_text_score: null, interpretation_reading_score: 0 };
type Reading = Readonly<{ alternative: number; frame: string; probes: Readonly<RecallQueryProbes> }>;
/** Borrowed reading fields only; neither a source interpretation nor its proof is retained here. */
type FrameReading = Readonly<{ id: string; predicate_support: Readonly<{ reading: string }> }>;

function sourceRecallAccessOrderCost(count: number): Readonly<{ work_units: number; memory_bytes: number }> {
  return { work_units: count * Math.ceil(Math.log2(count + 1)), memory_bytes: count * 16 };
}

/** Internal native policy. Semantic gateways supply verified reading facts, never a comparator. */
export function createSourceRecallAccessPolicy(original: string,
  compileReadings: (compile: (text: string) => Readonly<RecallQueryProbes>) => readonly Reading[],
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
  const readings = compileReadings(compile);
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
    const cost = sourceRecallAccessOrderCost(rows.length);
    ledger.charge(cost.work_units, cost.memory_bytes, "access ordering");
    return [...rows].sort(compareRows);
  };
  const sourceHints = new Map<string, SourceSemanticAccessSignal>();
  return {
    orderCost: sourceRecallAccessOrderCost,
    navigationQuery: (ledger: SourceSemanticResourceLedger, route: "original" | "hint" = "original"): string | null => {
      if (policy === "canonical-v1") return null;
      const navigation = route === "original" ? original : accessHint;
      if (navigation === undefined || route === "hint" && navigation === original) return null;
      chargeQueryFeatures(navigation, ledger);
      return navigation;
    },
    sourceCost: (length: number) => cost(length, originalProbes),
    source: (text: string, ledger: SourceSemanticResourceLedger): SourceSemanticAccessSignal => ({
      source_text_score: score(text, originalProbes, ledger), interpretation_reading_score: 0
    }),
    interpretation: (source: SourceSemanticAccessSignal, frames: readonly FrameReading[],
      ledger: SourceSemanticResourceLedger): SourceSemanticAccessSignal => {
      let best: SourceSemanticAccessSignal = { source_text_score: source.source_text_score, interpretation_reading_score: 0 };
      for (const queryReading of readings) for (const frame of frames) {
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
      let priorityOffset = 0, cursorOffset = 0;
      while (priorityOffset < priority.length || cursorOffset < exploration.length) {
        priorityOffset = takeNext(priority, priorityOffset);
        cursorOffset = takeNext(exploration, cursorOffset);
      }
      return scheduled;
    }
  };
}
