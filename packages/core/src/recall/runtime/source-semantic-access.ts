import {
  canonicalJson, type RequestBudget, type SourceSemanticAccessPolicy, type SourceSemanticAccessSignal,
  type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticResourceLedger
} from "@do-soul/alaya-protocol";
import { scoreQueryEvidenceContent } from "../../embedding-recall/evidence/query-evidence-scoring.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { compileRecallQueryProbes, type RecallQueryProbes } from "../query/recall-query-probes.js";

export function sourceSemanticAccessInputIdentity(input: Readonly<{
  original_query: string; query_semantics?: SourceSemanticQuery; source_id?: string;
  budget: RequestBudget; policy: SourceSemanticAccessPolicy;
}>): string {
  return `sha256:${fieldContractSha256(canonicalJson(input))}`;
}

/** One local access policy for raw sources and verified interpretations. It does not establish correspondence. */
export function createSourceSemanticAccessPolicy(original: string, query: SourceSemanticQuery | undefined,
  policy: SourceSemanticAccessPolicy, meter: SourceSemanticResourceLedger) {
  const compile = (text: string): Readonly<RecallQueryProbes> => {
    meter.charge(64 * (text.length + 1), 128 * (text.length + 1), "access query features");
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
  const compare = (a: Scored, b: Scored): number => {
    if (policy === "query-conditioned-v1") {
      const raw = (b.signal.source_text_score ?? 0) - (a.signal.source_text_score ?? 0);
      if (raw !== 0) return raw;
      const reading = b.signal.interpretation_reading_score - a.signal.interpretation_reading_score;
      if (reading !== 0) return reading;
    }
    return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
  };
  const order = <T extends Scored>(rows: readonly T[], ledger: SourceSemanticResourceLedger): T[] => {
    ledger.charge(rows.length * Math.ceil(Math.log2(rows.length + 1)), rows.length * 16, "access ordering");
    return [...rows].sort(compare);
  };
  return {
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
    order,
    schedule: <T extends { readonly identity: string; readonly source_hash: string | null }>(rows: readonly T[],
      sources: readonly { readonly digest: string; readonly signal: SourceSemanticAccessSignal }[],
      ledger: SourceSemanticResourceLedger): T[] => {
      ledger.charge(rows.length, rows.length * 8, "access verification schedule");
      if (policy === "canonical-v1") return [...rows];
      const signals = new Map<string, SourceSemanticAccessSignal>();
      for (const source of sources) {
        ledger.charge(1, source.digest.length * 2 + 48, "access source hint association");
        const prior = signals.get(source.digest);
        if (prior === undefined || compare({ identity: "", signal: source.signal }, { identity: "", signal: prior }) < 0) {
          signals.set(source.digest, source.signal);
        }
      }
      const hinted = rows.map((row) => ({ ...row, signal: signals.get(row.source_hash ?? "")
        ?? { source_text_score: null, interpretation_reading_score: 0 } }));
      ledger.retain(hinted, "access header hints");
      const priority = order(hinted, ledger), seen = new Set<string>(), scheduled: T[] = [];
      // A hash only schedules work. Alternating cursor exploration keeps wrong/missing
      // hashes and reading-only matches reachable without granting the hint authority.
      for (let index = 0; index < rows.length; index++) for (const row of [priority[index]!, rows[index]!]) {
        ledger.charge(1, 16, "access schedule deduplication");
        if (seen.has(row.identity)) continue;
        seen.add(row.identity); scheduled.push(row);
      }
      return scheduled;
    }
  };
}
