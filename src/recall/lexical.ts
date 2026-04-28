import type { MemoryEntry } from "../ontology/types.js";
import {
  buildStructuredContribution,
  compareCandidates,
  countCodepoints,
  createCandidate,
  normalizeLimit,
  normalizeSearchText,
  roundScore,
  tokenizeSearchText
} from "./shared.js";
import type {
  RankLexicalRecallCandidatesInput,
  RecallCandidate,
  RecallExclusion,
  RecallMergeResult,
  RecallRouteContribution
} from "./types.js";
import { evaluateRecordEligibility } from "./shared.js";

export function rankLexicalRecallCandidates(input: RankLexicalRecallCandidatesInput): RecallMergeResult {
  const limit = normalizeLimit(input.query.limit);
  if (limit === 0) {
    return {
      candidates: Object.freeze([]),
      exclusions: Object.freeze([]),
      degradations: Object.freeze([])
    };
  }

  const queryTokens = tokenizeSearchText(input.query.query_text);
  if (queryTokens.length === 0) {
    return {
      candidates: Object.freeze([]),
      exclusions: Object.freeze([]),
      degradations: Object.freeze([])
    };
  }

  const candidates: RecallCandidate[] = [];
  const exclusions: RecallExclusion[] = [];

  for (const record of input.records) {
    const eligibility = evaluateRecordEligibility(record, input.query, "lexical");
    if (!eligibility.eligible) {
      exclusions.push(eligibility.exclusion);
      continue;
    }

    const lexical = scoreLexicalMatch(record.memory, queryTokens);
    if (lexical.score <= 0) {
      continue;
    }

    const lexicalContribution: RecallRouteContribution = {
      route: "lexical",
      source_plane: "ontology",
      score: lexical.score,
      reason: "query_terms_matched_memory_content_or_tags",
      matched_terms: lexical.matchedTerms
    };

    candidates.push(createCandidate({
      memory: record.memory,
      inclusionReason: "structured_filters_passed_and_lexical_match",
      contributions: [buildStructuredContribution(record.memory), lexicalContribution]
    }));
  }

  return {
    candidates: Object.freeze(candidates.sort(compareCandidates).slice(0, limit)),
    exclusions: Object.freeze(exclusions.sort((left, right) => left.object_id.localeCompare(right.object_id))),
    degradations: Object.freeze([])
  };
}

function scoreLexicalMatch(
  memory: MemoryEntry,
  queryTokens: readonly string[]
): { readonly score: number; readonly matchedTerms: readonly string[] } {
  const searchableText = normalizeSearchText(`${memory.content} ${memory.domain_tags.join(" ")}`);
  const exactTokens = new Set(tokenizeSearchText(searchableText));
  const matchedTerms: string[] = [];
  let score = 0;

  for (const token of queryTokens) {
    const tokenLength = countCodepoints(token);
    const exactMatch = exactTokens.has(token);

    if (tokenLength < 3) {
      if (exactMatch) {
        matchedTerms.push(token);
        score += 4;
      }
      continue;
    }

    if (searchableText.includes(token)) {
      matchedTerms.push(token);
      score += exactMatch ? 4 : 3.5;
      continue;
    }

    const overlap = scoreTrigramOverlap(token, searchableText);
    if (overlap > 0) {
      matchedTerms.push(token);
      score += overlap;
    }
  }

  return {
    score: roundScore(score),
    matchedTerms: Object.freeze(matchedTerms)
  };
}

function scoreTrigramOverlap(queryToken: string, searchableText: string): number {
  const queryTrigrams = trigrams(queryToken);
  if (queryTrigrams.length === 0) {
    return 0;
  }

  let hits = 0;
  for (const trigram of queryTrigrams) {
    if (searchableText.includes(trigram)) {
      hits += 1;
    }
  }

  if (hits === 0) {
    return 0;
  }
  return roundScore((hits / queryTrigrams.length) * 2);
}

function trigrams(value: string): readonly string[] {
  const chars = Array.from(value);
  if (chars.length < 3) {
    return Object.freeze([]);
  }
  const result: string[] = [];
  for (let index = 0; index <= chars.length - 3; index += 1) {
    const first = chars[index];
    const second = chars[index + 1];
    const third = chars[index + 2];
    if (first !== undefined && second !== undefined && third !== undefined) {
      result.push(`${first}${second}${third}`);
    }
  }
  return Object.freeze(result);
}
