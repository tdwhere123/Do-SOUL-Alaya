import {
  computeExtractionKeySetSha256,
  type ExtractionContentClosureIndex,
  type ExtractionContentClosureIndexValue
} from "./content-closure.js";

export type ExtractionFillStatus = "in_progress" | "complete";

export interface ExtractionFillQuestionWindow {
  readonly offset: number;
  readonly limit: number;
}

export interface ExtractionFillManifestContract {
  readonly fill_status?: ExtractionFillStatus;
  readonly window_offset?: number;
  readonly window_limit?: number;
  readonly expected_turns?: number;
  readonly expected_key_set_sha256?: string;
  readonly content_closure_sha256?: string;
  readonly content_closure_index?: ExtractionContentClosureIndex;
}

export type ExtractionFillSummaryContract = Omit<
  ExtractionFillManifestContract,
  "content_closure_index"
>;

export function parseExtractionFillManifestContract(
  record: Readonly<Record<string, unknown>>,
  filePath: string
): ExtractionFillManifestContract {
  if (record.fill_status === undefined) {
    assertNoScopedFields(record, filePath);
    return {};
  }
  const contract: ExtractionFillManifestContract & {
    readonly fill_status: ExtractionFillStatus;
    readonly window_offset: number;
    readonly window_limit: number;
    readonly expected_turns: number;
    readonly expected_key_set_sha256: string;
  } = {
    fill_status: requireStatus(record.fill_status, filePath),
    window_offset: requireCount(record.window_offset, "window_offset", filePath),
    window_limit: requireCount(record.window_limit, "window_limit", filePath),
    expected_turns: requireCount(record.expected_turns, "expected_turns", filePath),
    expected_key_set_sha256: requireDigest(
      record.expected_key_set_sha256,
      "expected_key_set_sha256",
      filePath
    ),
    ...(record.content_closure_sha256 === undefined ? {} : {
      content_closure_sha256: requireDigest(
        record.content_closure_sha256,
        "content_closure_sha256",
        filePath
      )
    }),
    ...optionalContentClosureIndex(record.content_closure_index, filePath)
  };
  assertScopedCounts(record, contract, filePath);
  return contract;
}

function assertNoScopedFields(
  record: Readonly<Record<string, unknown>>,
  filePath: string
): void {
  const fields = [
    "window_offset", "window_limit", "expected_turns", "expected_key_set_sha256",
    "content_closure_sha256", "content_closure_index"
  ];
  if (!fields.some((field) => record[field] !== undefined)) return;
  throw new Error(
    `extraction cache manifest at ${filePath} requires fill_status with scoped fill fields`
  );
}

function assertScopedCounts(
  record: Readonly<Record<string, unknown>>,
  contract: ExtractionFillManifestContract & {
    readonly fill_status: ExtractionFillStatus;
    readonly expected_turns: number;
  },
  filePath: string
): void {
  const requested = requireCount(record.requested_turns, "requested_turns", filePath);
  const cached = requireCount(record.cached_turns, "cached_turns", filePath);
  const coverage = requireCoverage(record.coverage, filePath);
  if (requested !== contract.expected_turns || cached > requested) {
    throw new Error(`extraction cache manifest at ${filePath} has inconsistent fill counts`);
  }
  const expectedCoverage = requested === 0 ? 1 : cached / requested;
  if (Math.abs(coverage - expectedCoverage) > 1e-12) {
    throw new Error(`extraction cache manifest at ${filePath} has inconsistent fill coverage`);
  }
  if (contract.fill_status === "complete" && cached !== requested) {
    throw new Error(`extraction cache manifest at ${filePath} marks an incomplete fill complete`);
  }
  assertContentClosureState(contract, filePath);
}

function assertContentClosureState(
  contract: ExtractionFillManifestContract & {
    readonly fill_status: ExtractionFillStatus;
    readonly expected_turns: number;
    readonly expected_key_set_sha256?: string;
  },
  filePath: string
): void {
  const index = contract.content_closure_index;
  if (contract.fill_status === "in_progress" &&
      (contract.content_closure_sha256 !== undefined || index !== undefined)) {
    throw new Error(
      `extraction cache manifest at ${filePath} cannot finalize content while in_progress`
    );
  }
  if (index === undefined) return;
  if (contract.content_closure_sha256 === undefined ||
      Object.keys(index).length !== contract.expected_turns ||
      computeExtractionKeySetSha256(Object.keys(index)) !==
        contract.expected_key_set_sha256) {
    throw new Error(
      `extraction cache manifest at ${filePath} has inconsistent content closure index`
    );
  }
}

function requireStatus(value: unknown, filePath: string): ExtractionFillStatus {
  if (value === "in_progress" || value === "complete") return value;
  throw new Error(`extraction cache manifest at ${filePath} has invalid fill_status`);
}

function requireCount(value: unknown, field: string, filePath: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(
    `extraction cache manifest at ${filePath} field "${field}" must be a non-negative integer`
  );
}

function requireCoverage(value: unknown, filePath: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  throw new Error(`extraction cache manifest at ${filePath} requires scoped fill coverage`);
}

function requireDigest(value: unknown, field: string, filePath: string): string {
  if (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)) return value;
  throw new Error(
    `extraction cache manifest at ${filePath} requires ${field}`
  );
}

function optionalContentClosureIndex(
  value: unknown,
  filePath: string
): Pick<ExtractionFillManifestContract, "content_closure_index"> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `extraction cache manifest at ${filePath} has invalid content_closure_index`
    );
  }
  const rows = Object.entries(value).map(([cacheKey, row]) => [
    requireDigest(cacheKey, "content_closure_index cache key", filePath),
    requireContentClosureIndexValue(row, filePath)
  ] as const).sort(([left], [right]) => left.localeCompare(right));
  return { content_closure_index: Object.fromEntries(rows) };
}

function requireContentClosureIndexValue(
  value: unknown,
  filePath: string
): ExtractionContentClosureIndexValue {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(
      `extraction cache manifest at ${filePath} has invalid content_closure_index row`
    );
  }
  return [
    requireDigest(value[0], "content_closure_index raw digest", filePath),
    requireCount(value[1], "content_closure_index raw count", filePath),
    requireCount(value[2], "content_closure_index draft count", filePath)
  ];
}
