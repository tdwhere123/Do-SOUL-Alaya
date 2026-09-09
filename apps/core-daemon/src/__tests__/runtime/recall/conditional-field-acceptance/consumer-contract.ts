import {
  InformationIndexSchema,
  type CompletenessReport,
  type IndexEntry,
  type InformationIndex
} from "@do-soul/alaya-protocol";

export const CONTRACT_ONLY_UNTIL_REAL_PRODUCERS = "contract-only until real producers bind";

export const FORBIDDEN_CONSUMER_KEYS = [
  "ranking_authority",
  "delivery_path",
  "strategy_mix",
  "results"
] as const;

export type TargetConsumerPayload = Readonly<{
  readonly schema_version: 1;
  readonly surface: "mcp" | "cli";
  readonly bound: boolean;
  readonly note: string;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly result_version: string;
  readonly provider_calls: number;
  readonly garden_enqueue: number;
  readonly index: InformationIndex;
}>;

export function entryIdentity(entry: Pick<IndexEntry, "object_id" | "hypothesis_id" | "output_binding" | "target">): string {
  const id = entry.object_id
    ?? (entry.target.kind === "memory_entry" ? entry.target.object_id : entry.target.root_id);
  return `${entry.hypothesis_id}\0${entry.output_binding}\0${id}`;
}

export function assertTargetConsumer(payload: TargetConsumerPayload): readonly string[] {
  const failures: string[] = [];
  InformationIndexSchema.parse(payload.index);
  const encoded = payload as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_CONSUMER_KEYS) {
    if (key in encoded) failures.push(`forbidden consumer key ${key}`);
  }
  const indexRecord = payload.index as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_CONSUMER_KEYS) {
    if (key in indexRecord) failures.push(`forbidden index key ${key}`);
  }
  if (payload.provider_calls !== 0) failures.push("normal entry must not call a provider");
  if (payload.garden_enqueue !== 0) failures.push("normal entry must not enqueue extraction");
  if (payload.query_id !== payload.index.query_id) failures.push("query identity drifted");
  if (payload.snapshot_id !== payload.index.snapshot_id) failures.push("snapshot identity drifted");
  if (payload.result_version !== payload.index.result_version) failures.push("result identity drifted");
  if (payload.index.representation.policy !== "construct_index_then_page_then_payload") {
    failures.push("representation policy drifted");
  }
  return failures;
}

export function assertUnknownCauseAllowed(index: InformationIndex): readonly string[] {
  const failures: string[] = [];
  const unknown = index.entries.filter((entry) => entry.claim === "unknown");
  const explained = index.entries.filter((entry) => entry.explanation_ids.length > 0);
  if (unknown.length === 0 && explained.length === 0) {
    failures.push("completed field has neither unknown cause nor explained support");
  }
  if (unknown.length > 0 && index.completeness.logical_index !== "complete") {
    failures.push("unknown cause must remain representable on a complete logical index");
  }
  return failures;
}

export function assertPartialTransport(index: InformationIndex): readonly string[] {
  const failures: string[] = [];
  if (index.continuation === null) failures.push("first page of a larger index needs a continuation");
  if (index.completeness.transport !== "partial") failures.push("page transport must stay partial");
  if (index.completeness.payload !== "partial") failures.push("page payload must stay partial");
  if (index.completeness.transport === "complete" && index.continuation !== null) {
    failures.push("page masquerades as full index");
  }
  if (JSON.stringify(index.completeness).includes("complete_inline")) {
    failures.push("complete_inline is not a completeness dimension");
  }
  return failures;
}

export function assertPageContinuity(
  pages: readonly InformationIndex[],
  full: InformationIndex
): readonly string[] {
  const failures: string[] = [];
  for (const page of pages) {
    if (page.query_id !== full.query_id) failures.push("page query identity drifted");
    if (page.snapshot_id !== full.snapshot_id) failures.push("page snapshot identity drifted");
    if (page.result_version !== full.result_version) failures.push("page result identity drifted");
  }
  const concatenated = pages.flatMap((page) => page.entries).map(entryIdentity);
  const expected = full.entries.map(entryIdentity);
  if (concatenated.join("|") !== expected.join("|")) {
    failures.push("pages do not concatenate to the full index");
  }
  return failures;
}

export function assertNoReselection(
  payload: TargetConsumerPayload,
  expectedOrder: readonly string[]
): readonly string[] {
  const failures: string[] = [...assertTargetConsumer(payload)];
  const actual = payload.index.entries.map(entryIdentity);
  if (actual.join("|") !== expectedOrder.join("|")) {
    failures.push("downstream candidate reselection changed index order");
  }
  return failures;
}

export function completenessDimensions(report: CompletenessReport): readonly string[] {
  return [
    report.logical_index,
    report.observed_coverage,
    report.transport,
    report.payload,
    report.representation
  ];
}
