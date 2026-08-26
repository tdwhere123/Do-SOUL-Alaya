import type { CoarseRecallCandidate } from "../recall-service-types.js";
import { buildRecallCandidateDedupeKey } from "../recall-service-helpers.js";

export function freezeLexicalCoarseWithWarm<TLexical extends {
  readonly recallPhaseStart: number;
  readonly recallAfterCoarse: number;
  readonly recallAfterSynthesis: number;
  readonly coarseFilter: Readonly<{ synthesisFtsRanks: unknown }>;
  readonly globalCoarseFilter: unknown;
  readonly globalRecallClassifications: unknown;
  readonly lexicalCoarseCandidates: readonly Readonly<CoarseRecallCandidate>[];
}>(input: Readonly<{
  readonly recallPhaseStart: number;
  readonly recallAfterCoarse: number;
  readonly recallAfterSynthesis: number;
  readonly coarseFilter: TLexical["coarseFilter"];
  readonly synthesisFtsRanks: TLexical["coarseFilter"]["synthesisFtsRanks"];
  readonly global: Readonly<{
    readonly raw: TLexical["globalCoarseFilter"];
    readonly classifications: TLexical["globalRecallClassifications"];
  }>;
  readonly lexicalCoarseCandidates: readonly Readonly<CoarseRecallCandidate>[];
}>): TLexical {
  return {
    recallPhaseStart: input.recallPhaseStart,
    recallAfterCoarse: input.recallAfterCoarse,
    recallAfterSynthesis: input.recallAfterSynthesis,
    coarseFilter: Object.freeze({
      ...input.coarseFilter,
      synthesisFtsRanks: input.synthesisFtsRanks
    }),
    globalCoarseFilter: input.global.raw,
    globalRecallClassifications: input.global.classifications,
    lexicalCoarseCandidates: input.lexicalCoarseCandidates
  } as TLexical;
}

export function freezeCoarseStageResult<
  TLexical extends {
    readonly recallPhaseStart: number;
    readonly recallAfterCoarse: number;
    readonly recallAfterSynthesis: number;
    readonly coarseFilter: unknown;
    readonly globalCoarseFilter: unknown;
    readonly globalRecallClassifications: unknown;
    readonly lexicalCoarseCandidates: readonly Readonly<CoarseRecallCandidate>[];
  },
  TInjection extends { readonly candidates: readonly Readonly<CoarseRecallCandidate>[] }
>(
  lexical: TLexical,
  embeddingCoarseInjection: TInjection,
  recallAfterEmbedding: number,
  combineEmbeddingInjection: (
    lexicalCandidates: readonly Readonly<CoarseRecallCandidate>[],
    injectedCandidates: readonly Readonly<CoarseRecallCandidate>[]
  ) => readonly Readonly<CoarseRecallCandidate>[]
): Readonly<{
  readonly recallPhaseStart: number;
  readonly recallAfterCoarse: number;
  readonly recallAfterSynthesis: number;
  readonly recallAfterEmbedding: number;
  readonly coarseFilter: TLexical["coarseFilter"];
  readonly globalCoarseFilter: TLexical["globalCoarseFilter"];
  readonly globalRecallClassifications: TLexical["globalRecallClassifications"];
  readonly combinedCoarseCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly e0CandidateKeys: readonly string[];
  readonly embeddingCoarseInjection: TInjection;
}> {
  return Object.freeze({
    recallPhaseStart: lexical.recallPhaseStart,
    recallAfterCoarse: lexical.recallAfterCoarse,
    recallAfterSynthesis: lexical.recallAfterSynthesis,
    recallAfterEmbedding,
    coarseFilter: lexical.coarseFilter,
    globalCoarseFilter: lexical.globalCoarseFilter,
    globalRecallClassifications: lexical.globalRecallClassifications,
    combinedCoarseCandidates: combineEmbeddingInjection(
      lexical.lexicalCoarseCandidates,
      embeddingCoarseInjection.candidates
    ),
    e0CandidateKeys: Object.freeze(
      lexical.lexicalCoarseCandidates.map(buildRecallCandidateDedupeKey)
    ),
    embeddingCoarseInjection
  });
}
