export type IndexAlignedBatchFailure = Readonly<{
  readonly failureClass:
    | "result_count_mismatch"
    | "result_limit_exceeded"
    | "result_shape_mismatch"
    | "service_error";
  readonly returnedCount: number | null;
  readonly validBatchCount: number | null;
  readonly invalidIndex: number | null;
}>;

type BatchOutcome<Hit> = Readonly<
  | { readonly kind: "success"; readonly batches: readonly (readonly Hit[])[] }
  | { readonly kind: "failure"; readonly failure: IndexAlignedBatchFailure }
  | { readonly kind: "unavailable" }
>;

type LoadIndexAlignedSearchBatchesParams<Lookup, Hit> = Readonly<{
  readonly lookups: readonly Lookup[];
  readonly searchMany?: (lookups: readonly Lookup[]) => Promise<unknown>;
  readonly searchOne?: (lookup: Lookup) => Promise<readonly Hit[]>;
  readonly isHit: (value: unknown) => value is Hit;
  readonly maxHitsForLookup: (lookup: Lookup) => number;
  readonly onBatchFailure: (failure: IndexAlignedBatchFailure, hasScalar: boolean) => void;
  readonly onUnavailable?: () => void;
}>;

export async function loadIndexAlignedSearchBatches<Lookup, Hit>(
  params: LoadIndexAlignedSearchBatchesParams<Lookup, Hit>
): Promise<readonly (readonly Hit[])[]> {
  if (params.lookups.length === 0) return [];
  const outcome = await tryBatchSearch(params);
  if (outcome.kind === "success") return outcome.batches;
  const searchOne = params.searchOne;
  const hasScalar = searchOne !== undefined;
  if (outcome.kind === "failure") params.onBatchFailure(outcome.failure, hasScalar);
  if (!hasScalar) {
    if (outcome.kind === "unavailable") params.onUnavailable?.();
    return params.lookups.map(() => Object.freeze([]));
  }
  return loadScalarBatches(params.lookups, searchOne);
}

async function tryBatchSearch<Lookup, Hit>(
  params: LoadIndexAlignedSearchBatchesParams<Lookup, Hit>
): Promise<BatchOutcome<Hit>> {
  if (params.searchMany === undefined) return Object.freeze({ kind: "unavailable" });
  try {
    return validateBatchResult(
      await params.searchMany(params.lookups),
      params.lookups,
      params.isHit,
      params.maxHitsForLookup
    );
  } catch {
    return batchFailure("service_error");
  }
}

function validateBatchResult<Lookup, Hit>(
  value: unknown,
  lookups: readonly Lookup[],
  isHit: (value: unknown) => value is Hit,
  maxHitsForLookup: (lookup: Lookup) => number
): BatchOutcome<Hit> {
  if (!Array.isArray(value)) return batchFailure("result_shape_mismatch");
  if (value.length !== lookups.length) {
    return batchFailure("result_count_mismatch", { returnedCount: value.length });
  }
  let validCount = 0;
  let failureClass: IndexAlignedBatchFailure["failureClass"] | null = null;
  let invalidIndex: number | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isValidHitBatch(value[index], isHit)) {
      failureClass ??= "result_shape_mismatch";
      invalidIndex ??= index;
    } else if (value[index].length > maxHitsForLookup(lookups[index]!)) {
      failureClass ??= "result_limit_exceeded";
      invalidIndex ??= index;
    } else {
      validCount += 1;
    }
  }
  if (failureClass === null) return Object.freeze({ kind: "success", batches: value });
  return batchFailure(
    failureClass,
    { returnedCount: value.length, validBatchCount: validCount, invalidIndex }
  );
}

function isValidHitBatch<Hit>(
  value: unknown,
  isHit: (value: unknown) => value is Hit
): value is readonly Hit[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isHit(value[index])) return false;
  }
  return true;
}

async function loadScalarBatches<Lookup, Hit>(
  lookups: readonly Lookup[],
  searchOne: (lookup: Lookup) => Promise<readonly Hit[]>
): Promise<readonly (readonly Hit[])[]> {
  const batches: (readonly Hit[])[] = [];
  for (const lookup of lookups) batches.push(await searchOne(lookup));
  return batches;
}

function batchFailure<Hit>(
  failureClass: IndexAlignedBatchFailure["failureClass"],
  details: Partial<Omit<IndexAlignedBatchFailure, "failureClass">> = {}
): BatchOutcome<Hit> {
  return Object.freeze({
    kind: "failure",
    failure: Object.freeze({
      failureClass,
      returnedCount: details.returnedCount ?? null,
      validBatchCount: details.validBatchCount ?? null,
      invalidIndex: details.invalidIndex ?? null
    })
  });
}
