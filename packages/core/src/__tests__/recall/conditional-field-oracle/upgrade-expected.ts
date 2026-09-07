import {
  DerivationSchema,
  UsageReportSchema,
  type CompletenessStatus,
  type Derivation,
  type IndexEntry,
  type UsageReport
} from "@do-soul/alaya-protocol";
import { productIdentity } from "./oracle-index.js";

export const SNAPSHOT_DIGEST = `sha256:${"b".repeat(64)}`;

export type NecessityDisposition = "NOT_REQUIRED" | "BENEFIT_NOT_ESTABLISHED";

export type PublicEpoch = Readonly<{
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly interpretation_id: string;
  readonly as_of: string;
  readonly continuation_id: string;
}>;

export type ServiceBinding = Readonly<{
  readonly service_id: string;
  readonly provider_id: string;
}>;

export type InterpretationState = Readonly<{
  readonly hypotheses: readonly string[];
  readonly completed: readonly string[];
  readonly holes: readonly string[];
}>;

export type UsageCredit = Readonly<{
  readonly grain: UsageReport["grain"];
  readonly credited_ids: readonly string[];
}>;

export function leafDerivation(id: string, milligrades: number, revision = `src-${id}`): Derivation {
  return DerivationSchema.parse({
    schema_version: 1,
    derivation_id: id,
    kind: "leaf",
    children: [],
    observation_ids: [id],
    leaf_ids: [id],
    source_revisions: [revision],
    witness_id: `w-${id}`
  });
}

export function nodeDerivation(
  id: string,
  kind: "serial" | "and" | "or",
  children: readonly Derivation[]
): Derivation {
  return DerivationSchema.parse({
    schema_version: 1,
    derivation_id: id,
    kind,
    children: children.map((child) => child.derivation_id),
    observation_ids: children.flatMap((child) => child.observation_ids),
    leaf_ids: children.flatMap((child) => child.leaf_ids),
    source_revisions: children.flatMap((child) => child.source_revisions)
  });
}

export function andOrWithdrawalForest(): ReadonlyMap<string, Derivation> {
  const a = leafDerivation("a", 800);
  const b = leafDerivation("b", 800);
  const c = leafDerivation("c", 800);
  const andAb = nodeDerivation("and-ab", "and", [a, b]);
  const orLeft = nodeDerivation("or-left", "or", [andAb, c]);
  const orAb = nodeDerivation("or-ab", "or", [a, b]);
  const andRight = nodeDerivation("and-right", "and", [orAb, c]);
  return new Map([
    [a.derivation_id, a],
    [b.derivation_id, b],
    [c.derivation_id, c],
    [andAb.derivation_id, andAb],
    [orLeft.derivation_id, orLeft],
    [orAb.derivation_id, orAb],
    [andRight.derivation_id, andRight]
  ]);
}

export function withdrawLeaf(
  forest: ReadonlyMap<string, Derivation>,
  rootId: string,
  withdrawn: string
): Derivation | undefined {
  const current = forest.get(rootId);
  if (current === undefined) return undefined;
  if (current.kind === "leaf") {
    return current.derivation_id === withdrawn ? undefined : current;
  }
  const kept: Derivation[] = [];
  for (const childId of current.children) {
    const next = withdrawLeaf(forest, childId, withdrawn);
    if (next !== undefined) kept.push(next);
  }
  if (current.kind === "and" && kept.length !== current.children.length) return undefined;
  if (kept.length === 0) return undefined;
  if (kept.length === 1 && current.kind === "or") return kept[0];
  return nodeDerivation(`${current.derivation_id}-w`, current.kind, kept);
}

export function scalarOf(
  forest: ReadonlyMap<string, Derivation>,
  rootId: string,
  grades: Readonly<Record<string, number>>
): number | undefined {
  const current = forest.get(rootId);
  if (current === undefined) return undefined;
  if (current.kind === "leaf") return grades[current.derivation_id] ?? 0;
  const childGrades: number[] = [];
  for (const childId of current.children) {
    const grade = scalarOf(forest, childId, grades);
    if (grade === undefined) return undefined;
    childGrades.push(grade);
  }
  if (childGrades.length === 0) return 0;
  return current.kind === "or" ? Math.max(...childGrades) : Math.min(...childGrades);
}

export function explanationsComplete(
  forest: ReadonlyMap<string, Derivation>,
  rootId: string,
  observedLeaves: ReadonlySet<string>
): boolean {
  const current = forest.get(rootId);
  if (current === undefined) return false;
  if (current.kind === "leaf") return observedLeaves.has(current.derivation_id);
  if (current.kind === "and" || current.kind === "serial") {
    return current.children.every((childId) => explanationsComplete(forest, childId, observedLeaves));
  }
  return current.children.some((childId) => explanationsComplete(forest, childId, observedLeaves));
}

export function admitsSameService(query: ServiceBinding, candidate: ServiceBinding): boolean {
  return query.service_id === candidate.service_id;
}

export function plantedProviderBridge(query: ServiceBinding, candidate: ServiceBinding): boolean {
  return query.provider_id === candidate.provider_id;
}

export function interpretationCoverageOf(state: InterpretationState): CompletenessStatus {
  if (state.holes.length > 0) return "open";
  if (state.hypotheses.length === 0) return "complete";
  const completed = new Set(state.completed);
  return state.hypotheses.every((id) => completed.has(id)) ? "complete" : "open";
}

export function resumeDisposition(prior: PublicEpoch, next: PublicEpoch): "refine" | "invalidate" {
  return prior.query_id === next.query_id
    && prior.snapshot_id === next.snapshot_id
    && prior.interpretation_id === next.interpretation_id
    && prior.as_of === next.as_of
    && prior.continuation_id === next.continuation_id
    ? "refine"
    : "invalidate";
}

export function intermediateAuthorized(
  path: readonly string[],
  revoked: ReadonlySet<string>
): boolean {
  return path.every((node) => !revoked.has(node));
}

export function unfinishedAfterBudget(
  regions: readonly { readonly id: string; readonly required: boolean; readonly work: number }[],
  budget: number
): readonly string[] {
  let remaining = budget;
  const unfinished: string[] = [];
  for (const region of regions) {
    if (remaining < region.work) {
      if (region.required) unfinished.push(region.id);
      continue;
    }
    remaining -= region.work;
  }
  return unfinished;
}

export function cheapestRecoverableWitness(
  witnesses: readonly { readonly id: string; readonly cost: number; readonly complete: boolean }[],
  pageBudget: number
): string | undefined {
  let best: { readonly id: string; readonly cost: number } | undefined;
  for (const witness of witnesses) {
    if (!witness.complete || witness.cost > pageBudget) continue;
    if (best === undefined || witness.cost < best.cost) best = witness;
  }
  return best?.id;
}

export function creditFromReport(
  report: UsageReport,
  exposed: ReadonlySet<string>
): UsageCredit {
  if (report.grain === "output") {
    return { grain: "output", credited_ids: report.output_id === undefined ? [] : [report.output_id] };
  }
  if (report.grain === "object") {
    return { grain: "object", credited_ids: report.object_id === undefined ? [] : [report.object_id] };
  }
  if (report.grain === "action") {
    return { grain: "action", credited_ids: report.action_id === undefined ? [] : [report.action_id] };
  }
  if (report.exposure !== "exposed" || report.witness_id === undefined) {
    return { grain: "witness", credited_ids: [] };
  }
  return {
    grain: "witness",
    credited_ids: exposed.has(report.witness_id) ? [report.witness_id] : []
  };
}

export function plantedOutputCreditsEveryWitness(
  report: UsageReport,
  witnesses: readonly string[]
): readonly string[] {
  if (report.grain !== "output" || report.reported_use !== "used") return [];
  return witnesses;
}

export function foldReports(reports: readonly UsageReport[]): Readonly<{
  readonly unique: number;
  readonly duplicates: number;
  readonly nonexposure: number;
  readonly missing: number;
  readonly unknown: number;
}> {
  const seen = new Set<string>();
  let duplicates = 0;
  let nonexposure = 0;
  let missing = 0;
  let unknown = 0;
  for (const report of reports) {
    const identity = [
      report.grain,
      report.object_id ?? "",
      report.output_id ?? "",
      report.witness_id ?? "",
      report.action_id ?? "",
      report.query_id ?? "",
      report.snapshot_id ?? ""
    ].join("\0");
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    if (report.exposure === "nonexposure") nonexposure += 1;
    if (report.reported_use === "missing") missing += 1;
    if (report.reported_use === "unknown" || report.exposure === "unknown") unknown += 1;
  }
  return { unique: seen.size, duplicates, nonexposure, missing, unknown };
}

export function usageMayMutateStrength(): boolean {
  return false;
}

export function plantedUsageMutator(strength: number, used: boolean): number {
  return used ? Math.min(1, strength + 0.3) : strength;
}

export const NECESSITY_ROWS: readonly {
  readonly mechanism: string;
  readonly disposition: NecessityDisposition;
}[] = Object.freeze([
  { mechanism: "reinforcement-decay", disposition: "NOT_REQUIRED" },
  { mechanism: "conditional-program-learning", disposition: "BENEFIT_NOT_ESTABLISHED" },
  { mechanism: "cost-informed-scheduling", disposition: "BENEFIT_NOT_ESTABLISHED" },
  { mechanism: "exact-path-compilation", disposition: "NOT_REQUIRED" }
]);

export function finiteExamplesAreLearningGains(_exampleCount: number): boolean {
  return false;
}

export function collidingProductKeys(left: IndexEntry, right: IndexEntry): boolean {
  return productIdentity(left) === productIdentity(right);
}

export function plantedObjectOnlyMerge(left: IndexEntry, right: IndexEntry): boolean {
  return left.object_id === right.object_id;
}

export function actualBudgetRepresentsUniverse(
  pageBudget: number,
  universeSize: number,
  resourceOpen: boolean
): boolean {
  if (resourceOpen) return false;
  return pageBudget >= universeSize;
}

export function duplicatePathsMintIndependence(
  paths: readonly { readonly id: string; readonly sources: readonly string[] }[]
): boolean {
  const signatures = paths.map((path) => [...path.sources].sort().join("|"));
  return new Set(signatures).size === signatures.length && paths.length > 1;
}

export function outputReport(outputId: string): UsageReport {
  return UsageReportSchema.parse({
    schema_version: 1,
    grain: "output",
    exposure: "exposed",
    reported_use: "used",
    output_id: outputId,
    query_id: "q1",
    snapshot_id: SNAPSHOT_DIGEST
  });
}

export function witnessReport(
  witnessId: string,
  exposure: UsageReport["exposure"] = "exposed"
): UsageReport {
  return UsageReportSchema.parse({
    schema_version: 1,
    grain: "witness",
    exposure,
    reported_use: exposure === "exposed" ? "used" : "unknown",
    witness_id: witnessId,
    object_id: "cfg",
    query_id: "q1",
    snapshot_id: SNAPSHOT_DIGEST
  });
}

export function missingReport(objectId: string): UsageReport {
  return UsageReportSchema.parse({
    schema_version: 1,
    grain: "object",
    exposure: "unknown",
    reported_use: "missing",
    object_id: objectId,
    query_id: "q1",
    snapshot_id: SNAPSHOT_DIGEST
  });
}
