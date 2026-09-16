import type { GlobalMemoryEntry } from "@do-soul/alaya-protocol";
import { isCjkSegmentationCandidate, segmentCjkRun } from "@do-soul/alaya-cjk-segmentation";
import {
  compileRecallQueryProbes,
  isAdmittedLexicalTerm,
  splitLexicalTokens
} from "../../query/recall-query-probes.js";
import { selectBoundedTopK } from "./bounded-top-k.js";
import type { GlobalMemoryRecallSourcePort } from "../global-memory-recall-service.js";

const GLOBAL_RECALL_CORPUS_PAGE_LIMIT = 500;

export async function selectGlobalMemoryRecallEntries(
  source: GlobalMemoryRecallSourcePort,
  queryTokens: readonly string[] | null,
  limit: number
): Promise<readonly Readonly<GlobalMemoryEntry>[]> {
  if (source.listPage !== undefined) {
    return await selectPagedGlobalMemoryEntries(
      source.listPage.bind(source),
      queryTokens,
      limit
    );
  }
  const entries = source.listAll === undefined ? await source.list() : await source.listAll();
  return selectBoundedTopK(
    filterGlobalRecallEntries(entries, queryTokens),
    limit,
    compareGlobalMemoryRecallEntries
  );
}

async function selectPagedGlobalMemoryEntries(
  listPage: NonNullable<GlobalMemoryRecallSourcePort["listPage"]>,
  queryTokens: readonly string[] | null,
  limit: number
): Promise<readonly Readonly<GlobalMemoryEntry>[]> {
  let selected: Readonly<GlobalMemoryEntry>[] = [];
  for (let offset = 0; ; offset += GLOBAL_RECALL_CORPUS_PAGE_LIMIT) {
    const page = await listPage({
      limit: GLOBAL_RECALL_CORPUS_PAGE_LIMIT,
      offset
    });
    selected = selectBoundedTopK(
      [...selected, ...filterGlobalRecallEntries(page, queryTokens)],
      limit,
      compareGlobalMemoryRecallEntries
    );
    if (page.length < GLOBAL_RECALL_CORPUS_PAGE_LIMIT) {
      break;
    }
  }
  return selected;
}

export function normalizeGlobalMemoryQuery(queryText: string | null): readonly string[] | null {
  if (queryText === null) {
    return null;
  }
  const trimmed = queryText.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return dropCoveredCjkSurfaces(compileRecallQueryProbes(trimmed).lexical_terms);
}

function dropCoveredCjkSurfaces(terms: readonly string[]): readonly string[] {
  // FTS keeps the unsliced CJK surface plus jieba pieces; AND membership
  // cannot require that surface as a document token.
  const termSet = new Set(terms);
  return terms.filter((term) => {
    if (!isCjkSegmentationCandidate(term)) {
      return true;
    }
    return !segmentCjkRun(term).some((piece) => {
      const normalized = piece.trim().toLocaleLowerCase();
      return normalized.length > 0 && normalized !== term && termSet.has(normalized);
    });
  });
}

function filterGlobalRecallEntries(
  entries: readonly Readonly<GlobalMemoryEntry>[],
  queryTokens: readonly string[] | null
): readonly Readonly<GlobalMemoryEntry>[] {
  return queryTokens === null
    ? entries
    : entries.filter((entry) => matchesGlobalMemoryQuery(entry, queryTokens));
}

function matchesGlobalMemoryQuery(
  entry: Readonly<GlobalMemoryEntry>,
  queryTokens: readonly string[]
): boolean {
  if (queryTokens.length === 0) {
    return false;
  }
  const documentTokens = new Set(
    splitLexicalTokens(joinGlobalMemoryLexicalSurface(entry)).filter(isAdmittedLexicalTerm)
  );
  return queryTokens.every((token) => documentTokens.has(token));
}

function joinGlobalMemoryLexicalSurface(entry: Readonly<GlobalMemoryEntry>): string {
  return [entry.canonical_identity, entry.content, entry.provenance, ...entry.domain_tags].join(" ");
}

function compareGlobalMemoryRecallEntries(
  left: Readonly<GlobalMemoryEntry>,
  right: Readonly<GlobalMemoryEntry>
): number {
  const leftScore = left.activation_score ?? -1;
  const rightScore = right.activation_score ?? -1;
  if (leftScore !== rightScore) return rightScore - leftScore;
  if (left.updated_at !== right.updated_at) return right.updated_at.localeCompare(left.updated_at);
  if (left.created_at !== right.created_at) return right.created_at.localeCompare(left.created_at);
  return left.global_object_id.localeCompare(right.global_object_id);
}
