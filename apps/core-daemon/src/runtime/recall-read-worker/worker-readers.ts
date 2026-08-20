import type { PathAnchorRef } from "@do-soul/alaya-protocol";
import type { RecallPathProjectionReadOptions } from "../recall/recall-path-readers.js";
import {
  asPayload,
  readNumber,
  readPositiveIntegerArray,
  readString
} from "./payload-readers.js";

export const MAX_WORKER_PAGE_LIMIT = 5000;

export type WorkerKeywordSearchQuery = Readonly<{
  readonly queryText: string;
  readonly limit: number;
  readonly refinement_depths?: readonly number[];
}>;

export function readPathProjectionReadOptions(
  payload: Record<string, unknown>
): RecallPathProjectionReadOptions {
  if (payload.asOf === undefined) {
    return Object.freeze({});
  }
  return Object.freeze({ asOf: readString(payload.asOf, "asOf") });
}

export function readKeywordSearchBatchQueries(
  value: unknown
): readonly WorkerKeywordSearchQuery[] {
  if (!Array.isArray(value)) {
    throw new Error("worker payload queries must be an array");
  }
  return value.map((item, index) => {
    const query = asPayload(item);
    return {
      queryText: readString(query.queryText, `queries[${index}].queryText`),
      limit: readNumber(query.limit, `queries[${index}].limit`),
      ...(query.refinement_depths === undefined ? {} : {
        refinement_depths: readPositiveIntegerArray(
          query.refinement_depths,
          `queries[${index}].refinement_depths`
        )
      })
    };
  });
}

export function readPage(value: unknown): { readonly limit: number; readonly offset: number } {
  const payload = asPayload(value);
  const limit = readNumber(payload.limit, "page.limit");
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_WORKER_PAGE_LIMIT) {
    throw new Error(`worker payload page.limit must be an integer between 0 and ${MAX_WORKER_PAGE_LIMIT}`);
  }
  const offset = readNumber(payload.offset, "page.offset");
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("worker payload page.offset must be a non-negative integer");
  }
  return {
    limit,
    offset
  };
}

export function readAnchorRefs(value: unknown): readonly PathAnchorRef[] {
  if (!Array.isArray(value)) {
    throw new Error("worker payload anchorRefs must be an array");
  }
  return value as readonly PathAnchorRef[];
}

export async function runOrderedKeywordSearchBatch<Result>(
  queries: readonly WorkerKeywordSearchQuery[],
  searchOne: (query: WorkerKeywordSearchQuery) => Promise<readonly Result[]>
): Promise<readonly (readonly Result[])[]> {
  const batches: (readonly Result[])[] = [];
  for (const query of queries) batches.push(await searchOne(query));
  return batches;
}
