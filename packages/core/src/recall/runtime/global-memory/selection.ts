import type { GlobalMemoryEntry } from "@do-soul/alaya-protocol";
import { selectBoundedTopK } from "../../coarse-filter/selection/bounded-top-k.js";
import type { GlobalMemoryRecallSourcePort } from "../global-memory-recall-service.js";

const GLOBAL_RECALL_CORPUS_PAGE_LIMIT = 500;

export async function selectGlobalMemoryRecallEntries(
  source: GlobalMemoryRecallSourcePort,
  queryTokens: readonly string[] | null,
  limit: number
): Promise<readonly Readonly<GlobalMemoryEntry>[]> {
  if (source.listPage !== undefined) {
    const listPage = source.listPage.bind(source);
    try {
      return await selectPagedGlobalMemoryEntries(listPage, queryTokens, limit);
    } catch (error) {
      // listAll was authoritative when both ports existed, so it remains the compatibility fallback.
      if (source.listAll === undefined) throw error;
    }
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
  const haystack = [
    entry.canonical_identity,
    entry.content,
    entry.provenance,
    ...entry.domain_tags
  ]
    .join(" ")
    .toLowerCase();

  return queryTokens.every((token) => haystack.includes(token));
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
