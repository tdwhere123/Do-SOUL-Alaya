import { solveMaxMinField } from "@do-soul/alaya-graph-algorithms";
import { orderNativeRouteAccess, type NativeRouteLane } from "@do-soul/alaya-core";
import { AlayaError } from "@do-soul/alaya-protocol";

export const NAVIGATION_CONTRACT = "benchmark-conditional-navigation.v1" as const;
const TOP = 1024;
export type NavigationCondition = Readonly<{
  id: string; object: string; hypothesis: string; query: string;
  status: "ready" | "partial" | "unknown" | "unsupported" | "rejected";
  residual: string | null; provenance: string;
}>;
export type NavigationOccurrence = Readonly<{
  condition: string; channel: "lexical" | "vector"; native_rank: number;
  reference: string; root_key: string; record_id: string;
}>;
export type NavigationPool = readonly Readonly<{ record_id: string; catalog_position: number }>[];
export type NavigationInput = Readonly<{
  original: string; conditions: readonly NavigationCondition[]; occurrences: readonly NavigationOccurrence[];
  /** Each conjunction is local to one object/hypothesis. Compared objects require separate branches. */
  branches: readonly (readonly string[])[]; pool: NavigationPool;
}>;

function requireInput(test: boolean, reason: string): asserts test {
  if (!test) throw new AlayaError("VALIDATION", reason);
}

/** Private ordinal domain, NOT association milligrades or fact support. A tier is
 * TOP-(2*eligible lane offset+channel offset), lexical first. Native rank gaps
 * remain in witnesses, not interpolated observations. Equal tiers use catalog
 * position then opaque record id. Unobserved tails have no tier (not zero).
 * Partial means these observed tiers remain usable navigation lower bounds;
 * omitted conditions can still change ordering. It never certifies fidelity. */
export function solveConditionalNavigation(input: NavigationInput) {
  validate(input);
  const { tiers, native } = conditionTiers(input);
  const nodes: string[] = [], seeds = new Map<string, number>();
  const edges: { from: string; to: string; strength: number }[] = [];
  const assessments: { record_id: string; conditions: readonly string[]; status: string; tier: number | null }[] = [];
  const branches = [[input.original], ...input.branches];
  for (const member of input.pool) {
    const output = JSON.stringify(["output", member.record_id]); nodes.push(output);
    for (const [branchIndex, ids] of branches.entries()) {
      const states = ids.map(id => input.conditions.find(row => row.id === id)!);
      const grades = ids.map(id => tiers.get(JSON.stringify([id, member.record_id])));
      const status = states.some(row => row.status === "rejected") ? "rejected"
        : states.some(row => row.status === "unsupported") ? "unsupported"
          : states.some(row => row.status === "unknown") || grades.some(grade => grade === undefined) ? "unknown"
            : states.some(row => row.status === "partial") ? "partial" : "known";
      const usable = status === "known" || status === "partial";
      assessments.push({ record_id: member.record_id, conditions: ids, status,
        tier: usable ? Math.min(...grades as number[]) : null });
      if (!usable) continue;
      let prior = JSON.stringify([member.record_id, branchIndex, 0]);
      nodes.push(prior); seeds.set(prior, TOP);
      for (const [index, grade] of grades.entries()) {
        const next = JSON.stringify([member.record_id, branchIndex, index + 1]); nodes.push(next);
        edges.push({ from: prior, to: next, strength: grade! }); prior = next;
      }
      edges.push({ from: prior, to: output, strength: TOP });
    }
  }
  const solved = solveMaxMinField({ nodeIds: nodes, seeds, transitions: edges, bottom: 0, top: TOP });
  requireInput(solved.complete, "navigation solver did not finish");
  const rows = input.pool.map(member => {
    const tier = solved.values.get(JSON.stringify(["output", member.record_id]));
    return { ...member, navigation: tier === undefined || tier === 0 ? { status: "unknown" as const, tier: null }
      : { status: "observed" as const, tier },
    read: { status: "unobserved" as const }, conditional_support: { status: "unknown" as const } };
  });
  rows.sort((a, b) => (b.navigation.tier ?? -1) - (a.navigation.tier ?? -1)
    || a.catalog_position - b.catalog_position || compare(a.record_id, b.record_id));
  return { contract: NAVIGATION_CONTRACT, rows, assessments, native_single_condition: native,
    single_condition_equivalent: input.branches.length === 0
      ? rows.every((row, i) => row.record_id === native[i]) : null,
    solver: { nodes: nodes.length, edges: edges.length, steps: solved.steps } };
}

/** Native C remains the independent order authority for the same admitted inventory. */
function conditionTiers(input: NavigationInput) {
  const tiers = new Map<string, number>();
  let native: readonly string[] = [];
  for (const condition of input.conditions) {
    const occurrences = input.occurrences.filter(row => row.condition === condition.id);
    const lanes: NativeRouteLane[] = (["lexical", "vector"] as const).map((channel, offset) => {
      const rows = occurrences.filter(row => row.channel === channel).sort((a, b) => a.native_rank - b.native_rank);
      for (const [index, row] of rows.entries()) {
        const key = JSON.stringify([condition.id, row.record_id]);
        tiers.set(key, Math.max(tiers.get(key) ?? 0, TOP - (2 * index + offset)));
      }
      return { lane: `original-${channel}`, scope: "admitted-native-capture", ...(rows.length === 0
        ? { state: "measured-empty" as const } : { state: "exact-captured" as const,
          occurrences: rows.map(row => ({ reference: row.reference, root_key: row.root_key, native_rank: row.native_rank })) }) };
    });
    lanes.push({ lane: "hint-lexical", scope: "not-provided", state: "absent" },
      { lane: "hint-vector", scope: "not-provided", state: "absent" });
    const ordered = orderNativeRouteAccess({ lanes, pool: input.pool,
      acquired_root_keys: [...new Set(occurrences.map(row => row.root_key))],
      associations: occurrences.map(row => ({ occurrence_reference: row.reference, root_key: row.root_key, record_id: row.record_id })),
      unvisited_sources: true });
    requireInput(ordered.status === "ordered", "native matched inventory is not total");
    if (condition.id === input.original) native = ordered.record_ids;
  }
  return { tiers, native };
}

function validate(input: NavigationInput) {
  requireInput(input.pool.length <= 512 && input.conditions.length >= 1 && input.conditions.length <= 4
    && input.branches.length <= 3, "bounded navigation inventory exceeded");
  const ids = new Set(input.conditions.map(row => row.id)), records = new Set(input.pool.map(row => row.record_id));
  requireInput(ids.size === input.conditions.length && ids.has(input.original) && records.size === input.pool.length,
    "ambiguous navigation identity");
  requireInput(new Set(input.pool.map(row => row.catalog_position)).size === input.pool.length
    && input.pool.every(row => row.record_id.length > 0 && Number.isSafeInteger(row.catalog_position) && row.catalog_position >= 0),
  "invalid navigation catalog");
  for (const row of input.conditions) requireInput(row.id.length > 0 && row.query.length > 0 && row.object.length > 0
    && row.hypothesis.length > 0 && row.provenance.length > 0 && (row.status !== "partial" || !!row.residual), "invalid condition provenance");
  for (const branch of input.branches) {
    requireInput(branch.length > 0 && new Set(branch).size === branch.length && branch.every(id => ids.has(id)), "invalid condition branch");
    const states = branch.map(id => input.conditions.find(row => row.id === id)!);
    requireInput(states.every(row => row.object === states[0]!.object && row.hypothesis === states[0]!.hypothesis),
      "conditions on different compared objects or hypotheses cannot be conjoined");
  }
  requireInput(input.occurrences.length <= 512 && input.occurrences.every(row => ids.has(row.condition)
    && records.has(row.record_id) && Number.isSafeInteger(row.native_rank) && row.native_rank > 0 && row.native_rank <= 4096),
  "invalid native occurrence membership or rank");
}
function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
