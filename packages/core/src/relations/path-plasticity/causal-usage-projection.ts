import {
  getPathAnchorBackingObjectId,
  type CausalUsageReceipt,
  type PathRelation,
  type UsageReport
} from "@do-soul/alaya-protocol";
import {
  DEFAULT_USAGE_DECAY_PER_MS,
  projectSoftUsage
} from "../../governance/effects/causal-plasticity.js";

export type CausalUsagePathAttribution = Readonly<{
  readonly path_id: string;
  readonly receipt_identities: readonly string[];
  readonly writes_path_relation: false;
}>;

export type UsageReportAttribution = Readonly<{
  readonly grain: UsageReport["grain"];
  readonly exposure: UsageReport["exposure"];
  readonly reported_use: UsageReport["reported_use"];
  readonly query_id: string | undefined;
  readonly snapshot_id: string | undefined;
  readonly object_id: string | undefined;
  readonly output_id: string | undefined;
  readonly witness_id: string | undefined;
  readonly action_id: string | undefined;
  readonly path_credit: "none";
  readonly witness_credit: "none" | "claimed" | "unknown";
}>;

export function projectCausalUsageOntoPaths(
  paths: readonly Readonly<PathRelation>[],
  receipts: readonly Readonly<CausalUsageReceipt>[],
  asOf: string,
  decayPerMs: number = DEFAULT_USAGE_DECAY_PER_MS
): readonly Readonly<PathRelation>[] {
  const receiptsByRef = indexApplicableReceipts(receipts, asOf);
  return Object.freeze(paths.map((path) => {
    const applicable = receiptsForPath(path, receiptsByRef);
    if (applicable.length > 0) {
      // Soft mass is operational telemetry. Combining it into strength would
      // treat usage as a relation write, which the upgraded target forbids.
      void projectSoftUsage(
        applicable.map((receipt) => ({ receipt, channel: "usage" as const })),
        asOf,
        decayPerMs
      );
    }
    return Object.freeze({
      ...path,
      plasticity_state: Object.freeze({ ...path.plasticity_state })
    });
  }));
}

export function attributeCausalUsageOntoPaths(
  paths: readonly Readonly<PathRelation>[],
  receipts: readonly Readonly<CausalUsageReceipt>[],
  asOf: string
): readonly CausalUsagePathAttribution[] {
  const receiptsByRef = indexApplicableReceipts(receipts, asOf);
  return Object.freeze(paths.flatMap((path) => {
    const applicable = receiptsForPath(path, receiptsByRef);
    if (applicable.length === 0) return [];
    return [Object.freeze({
      path_id: path.path_id,
      receipt_identities: Object.freeze(applicable.map((receipt) => receipt.identity)),
      writes_path_relation: false
    })];
  }));
}

export function attributeUsageReports(
  reports: readonly UsageReport[]
): readonly UsageReportAttribution[] {
  return Object.freeze(uniqueUsageReports(reports).map((report) => Object.freeze({
    grain: report.grain,
    exposure: report.exposure,
    reported_use: report.reported_use,
    query_id: report.query_id,
    snapshot_id: report.snapshot_id,
    object_id: report.object_id,
    output_id: report.output_id,
    witness_id: report.witness_id,
    action_id: report.action_id,
    path_credit: "none",
    witness_credit: witnessCredit(report)
  })));
}

function witnessCredit(report: UsageReport): UsageReportAttribution["witness_credit"] {
  if (report.grain !== "witness") return "none";
  if (report.exposure === "unknown" || report.reported_use === "unknown") return "unknown";
  if (report.exposure === "exposed" && report.reported_use === "used") return "claimed";
  return "none";
}

function uniqueUsageReports(reports: readonly UsageReport[]): readonly UsageReport[] {
  const seen = new Set<string>();
  const unique: UsageReport[] = [];
  for (const report of reports) {
    const key = usageReportKey(report);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(report);
  }
  return unique;
}

function usageReportKey(report: UsageReport): string {
  return [
    report.grain,
    report.exposure,
    report.reported_use,
    report.query_id ?? "",
    report.snapshot_id ?? "",
    report.object_id ?? "",
    report.output_id ?? "",
    report.witness_id ?? "",
    report.action_id ?? ""
  ].join("\0");
}

function indexApplicableReceipts(
  receipts: readonly Readonly<CausalUsageReceipt>[],
  asOf: string
): ReadonlyMap<string, readonly Readonly<CausalUsageReceipt>[]> {
  const indexed = new Map<string, Readonly<CausalUsageReceipt>[]>();
  const asOfMs = Date.parse(asOf);
  for (const receipt of receipts) {
    if (
      receipt.scope === receipt.workspace_id &&
      receipt.usage_kind === "causal" &&
      receipt.weight > 0 &&
      Date.parse(receipt.occurred_at) <= asOfMs &&
      Date.parse(receipt.recorded_at) <= asOfMs
    ) {
      const key = receiptIndexKey(receipt.workspace_id, receipt.downstream_ref);
      const bucket = indexed.get(key) ?? [];
      bucket.push(receipt);
      indexed.set(key, bucket);
    }
  }
  return indexed;
}

function receiptsForPath(
  path: Readonly<PathRelation>,
  indexed: ReadonlyMap<string, readonly Readonly<CausalUsageReceipt>[]>
): readonly Readonly<CausalUsageReceipt>[] {
  const refs = [
    path.path_id,
    getPathAnchorBackingObjectId(path.anchors.source_anchor),
    getPathAnchorBackingObjectId(path.anchors.target_anchor)
  ];
  const unique = new Map<string, Readonly<CausalUsageReceipt>>();
  for (const ref of refs) {
    for (const receipt of indexed.get(receiptIndexKey(path.workspace_id, ref)) ?? []) {
      unique.set(receipt.identity, receipt);
    }
  }
  return Object.freeze([...unique.values()]);
}

function receiptIndexKey(workspaceId: string, downstreamRef: string): string {
  return `${workspaceId}\u0000${downstreamRef}`;
}
