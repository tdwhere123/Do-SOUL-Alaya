import {
  hashBundleId,
  hashLabeledIdentity,
  PROJECTION_GENERATION_OPERATOR_ID,
  type FieldContractSha256,
  type ProjectionEraseSubjectKind
} from "@do-soul/alaya-protocol";

import {
  assertSingleGeneration,
  type ProjectionL1Posting
} from "../field/retrieval/projection/l1-postings.js";
import { compareText } from "../../shared/compare-text.js";

export type ProjectionFactorSummary = Readonly<{
  readonly dimension: string;
  readonly value: string;
}>;

export type ProjectionL2Bundle = Readonly<{
  readonly bundle_id: string;
  readonly generation_id: string;
  readonly scope: string;
  readonly anchor_digest: string;
  readonly level: number;
  readonly member_refs: readonly string[];
  readonly child_bundle_ids: readonly string[];
  readonly factor_summary: readonly ProjectionFactorSummary[];
  readonly support_lineages: readonly string[];
  readonly unseen_frontier_upper_bound: number;
  readonly opened: boolean;
  readonly operator_id: typeof PROJECTION_GENERATION_OPERATOR_ID;
}>;

export type L2MaterializationPolicy = Readonly<{
  readonly materialize: boolean;
  readonly maxLevel: number;
  readonly maxMembers: number;
  readonly minMembers: number;
}>;

export function materializeSliceKeyL2Bundles(params: Readonly<{
  readonly generationId: string;
  readonly postings: readonly ProjectionL1Posting[];
  readonly sha256: FieldContractSha256;
  readonly policy: L2MaterializationPolicy;
  readonly scope?: string;
}>): readonly ProjectionL2Bundle[] {
  assertSingleGeneration(params.postings);
  if (!params.policy.materialize) return Object.freeze([]);
  const scope = params.scope ?? workspaceScope(params.postings);
  const levelOne = materializeLevelOneBundles(params, scope);
  const higher = params.policy.maxLevel >= 2
    ? materializeLevelTwoBundles(params, scope, levelOne.bundles, levelOne.identityBundleIds)
    : [];
  const bundles = Object.freeze([...levelOne.bundles, ...higher].sort((left, right) =>
    compareText(left.bundle_id, right.bundle_id)
  ));
  assertProjectionBundleLevelDag(bundles);
  return bundles;
}

export function assertProjectionBundleLevelDag(
  bundles: readonly ProjectionL2Bundle[]
): void {
  const byId = new Map(bundles.map((bundle) => [bundle.bundle_id, bundle]));
  for (const bundle of bundles) {
    if (bundle.level < 1 || !Number.isSafeInteger(bundle.level)) {
      throw new Error("bundle level DAG is invalid");
    }
    for (const childId of bundle.child_bundle_ids) {
      const child = byId.get(childId);
      if (child === undefined || child.level >= bundle.level) {
        throw new Error("bundle level DAG forbids same-or-higher children");
      }
    }
  }
}

export function applyEraseToL2Bundles(
  bundles: readonly ProjectionL2Bundle[],
  subjectId: string,
  subjectKind: ProjectionEraseSubjectKind,
  surfaces: readonly string[] = []
): readonly ProjectionL2Bundle[] {
  const wiped = new Set([subjectId, ...surfaces].filter((value) => value.length > 0));
  return Object.freeze(bundles.flatMap((bundle) => {
    const memberRefs = Object.freeze(bundle.member_refs.filter((member) =>
      subjectKind === "generation" ? false : member !== subjectId
    ));
    if (memberRefs.length === 0) return [];
    return [Object.freeze({
      ...bundle,
      member_refs: memberRefs,
      factor_summary: Object.freeze(bundle.factor_summary.map((factor) =>
        subjectKind === "generation" || wiped.has(factor.value)
          ? Object.freeze({ ...factor, value: "" })
          : factor
      )),
      support_lineages: Object.freeze(bundle.support_lineages.filter((lineage) =>
        subjectKind === "generation" ? false : lineage !== subjectId
      ))
    })];
  }));
}

function materializeLevelOneBundles(
  params: Parameters<typeof materializeSliceKeyL2Bundles>[0],
  scope: string
): Readonly<{
  readonly bundles: readonly ProjectionL2Bundle[];
  readonly identityBundleIds: ReadonlySet<string>;
}> {
  const groups = groupPostings(params.postings);
  const identityBundleIds = new Set<string>();
  const bundles = Object.freeze([...groups.entries()].flatMap(([anchorKey, group]) => {
    const uniqueMembers = uniqueSorted(group.members);
    if (uniqueMembers.length < params.policy.minMembers) return [];
    const bundle = createLevelOneBundle(params, scope, anchorKey, uniqueMembers);
    if (group.identity) identityBundleIds.add(bundle.bundle_id);
    return [bundle];
  }).sort((left, right) => compareText(left.bundle_id, right.bundle_id)));
  return Object.freeze({ bundles, identityBundleIds });
}

function createLevelOneBundle(
  params: Parameters<typeof materializeSliceKeyL2Bundles>[0],
  scope: string,
  anchorKey: string,
  uniqueMembers: readonly string[]
): ProjectionL2Bundle {
  const [dimension, value] = splitAnchorKey(anchorKey);
  return createBundle(params, scope, {
    anchorDigest: hashLabeledIdentity("bundle_anchor", [dimension, value], params.sha256),
    level: 1,
    members: uniqueMembers.slice(0, params.policy.maxMembers),
    children: [],
    summary: [Object.freeze({ dimension, value })]
  });
}

function materializeLevelTwoBundles(
  params: Parameters<typeof materializeSliceKeyL2Bundles>[0],
  scope: string,
  levelOne: readonly ProjectionL2Bundle[],
  identityBundleIds: ReadonlySet<string>
): readonly ProjectionL2Bundle[] {
  const pairs: ProjectionL2Bundle[] = [];
  for (const [left, right] of identityCoMemberPairs(levelOne, identityBundleIds)) {
    const members = uniqueSorted([...left.member_refs, ...right.member_refs])
      .slice(0, params.policy.maxMembers);
    pairs.push(createBundle(params, scope, {
      anchorDigest: hashLabeledIdentity("bundle_anchor", [
        left.bundle_id,
        right.bundle_id
      ], params.sha256),
      level: 2,
      members,
      children: [left.bundle_id, right.bundle_id],
      summary: Object.freeze([...left.factor_summary, ...right.factor_summary])
    }));
  }
  return Object.freeze(pairs.sort((left, right) =>
    compareText(left.bundle_id, right.bundle_id)
  ));
}

function identityCoMemberPairs(
  levelOne: readonly ProjectionL2Bundle[],
  identityBundleIds: ReadonlySet<string>
): readonly (readonly [ProjectionL2Bundle, ProjectionL2Bundle])[] {
  // Grounded L1 still routes at L1; pairing it would re-inflate co-member L2.
  const identity = levelOne.filter((bundle) => identityBundleIds.has(bundle.bundle_id));
  const byId = new Map(identity.map((bundle) => [bundle.bundle_id, bundle]));
  const memberBundleIds = new Map<string, string[]>();
  for (const bundle of identity) {
    for (const member of bundle.member_refs) {
      const ids = memberBundleIds.get(member) ?? [];
      ids.push(bundle.bundle_id);
      memberBundleIds.set(member, ids);
    }
  }
  const seen = new Set<string>();
  const pairs: (readonly [ProjectionL2Bundle, ProjectionL2Bundle])[] = [];
  for (const ids of memberBundleIds.values()) {
    const unique = uniqueSorted(ids);
    for (let leftIndex = 0; leftIndex < unique.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < unique.length; rightIndex += 1) {
        const pairKey = `${unique[leftIndex]}\0${unique[rightIndex]}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        pairs.push([byId.get(unique[leftIndex]!)!, byId.get(unique[rightIndex]!)!]);
      }
    }
  }
  return pairs;
}

function createBundle(
  params: Parameters<typeof materializeSliceKeyL2Bundles>[0],
  scope: string,
  input: Readonly<{
    readonly anchorDigest: string;
    readonly level: number;
    readonly members: readonly string[];
    readonly children: readonly string[];
    readonly summary: readonly ProjectionFactorSummary[];
  }>
): ProjectionL2Bundle {
  const bundleId = hashBundleId({
    scope,
    anchor_digest: input.anchorDigest,
    level: input.level,
    operator_id: PROJECTION_GENERATION_OPERATOR_ID,
    generation_id: params.generationId
  }, params.sha256);
  return Object.freeze({
    bundle_id: bundleId,
    generation_id: params.generationId,
    scope,
    anchor_digest: input.anchorDigest,
    level: input.level,
    member_refs: Object.freeze([...input.members]),
    child_bundle_ids: Object.freeze([...input.children]),
    factor_summary: Object.freeze(input.summary.map((factor) => Object.freeze({ ...factor }))),
    support_lineages: Object.freeze([...input.members]),
    unseen_frontier_upper_bound: 0,
    opened: true,
    operator_id: PROJECTION_GENERATION_OPERATOR_ID
  });
}

type GroupedL1Anchor = Readonly<{
  readonly members: readonly string[];
  readonly identity: boolean;
}>;

function groupPostings(
  postings: readonly ProjectionL1Posting[]
): ReadonlyMap<string, GroupedL1Anchor> {
  const groups = new Map<string, { members: string[]; identity: boolean }>();
  for (const posting of postings) {
    if (posting.erased || posting.source !== "slice_key") continue;
    const key = `${posting.dimension}\0${posting.normalized_value}`;
    const group = groups.get(key) ?? { members: [], identity: false };
    group.members.push(posting.member_ref);
    // Any F3 posting marks the whole L1; majority would hide mixed anchors.
    if (posting.authority === "proposed_routing_only") group.identity = true;
    groups.set(key, group);
  }
  return groups;
}

function workspaceScope(postings: readonly ProjectionL1Posting[]): string {
  return postings[0]?.generation_id ?? "workspace";
}

function splitAnchorKey(anchorKey: string): readonly [string, string] {
  const split = anchorKey.indexOf("\0");
  return [anchorKey.slice(0, split), anchorKey.slice(split + 1)];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

