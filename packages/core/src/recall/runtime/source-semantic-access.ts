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
    order: <T extends { readonly identity: string; readonly signal: SourceSemanticAccessSignal }>(
      rows: readonly T[], ledger: SourceSemanticResourceLedger): T[] => {
      ledger.charge(rows.length * Math.ceil(Math.log2(rows.length + 1)), rows.length * 16, "access ordering");
      return [...rows].sort((a, b) => {
        if (policy === "query-conditioned-v1") {
          const raw = (b.signal.source_text_score ?? 0) - (a.signal.source_text_score ?? 0);
          if (raw !== 0) return raw;
          const reading = b.signal.interpretation_reading_score - a.signal.interpretation_reading_score;
          if (reading !== 0) return reading;
        }
        return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
      });
    }
  };
}
